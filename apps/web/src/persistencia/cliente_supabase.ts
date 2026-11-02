/**
 * Fase 5 — Cliente Supabase Auth + PostgREST con RLS Estricto.
 *
 * REGLAS DE SEGURIDAD:
 *  - Lee la URL y la clave publishable/anon desde variables de entorno (`VITE_SUPABASE_URL`,
 *    `VITE_SUPABASE_PUBLISHABLE_KEY`).
 *  - Valida con `validarClavePublicaSupabaseEnCliente` que jamás se introduzca una
 *    clave `service_role` o `sb_secret_` en el cliente.
 *  - Mantiene el token de sesión (`accessToken`) únicamente en memoria de ejecución
 *    (no persiste claves secretas ni tokens sensibles en localStorage).
 */
import {
  ahoraISO,
  type ConfiguracionDominioGratuitoVercel,
  ENTIDADES_SINCRONIZABLES,
  evaluarCambioConcurrente,
  type ConflictoSincronizacion,
  type NombreEntidadSincronizable,
  PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO,
  type SobreSincronizacion,
  type TransporteNubeRls,
  validarClavePublicaSupabaseEnCliente,
  validarYConstruirConfiguracionDominioVercel,
} from '@mis-cuentas/core';

export interface SesionPropietarioSupabase {
  uid: string;
  email: string;
  accessToken: string;
  refreshToken?: string | null;
  expiraEnEpochSegundos: number;
}

const TABLA_POR_ENTIDAD: Record<NombreEntidadSincronizable, string> = {
  cuentas: 'cuentas_sync',
  categorias: 'categorias_sync',
  eventos: 'eventos_sync',
  presupuestos: 'presupuestos_sync',
  transacciones: 'transacciones_sync',
  gastos_planificados: 'gastos_planificados_sync',
  gastos_compartidos: 'gastos_compartidos_sync',
  liquidaciones_compartidas: 'liquidaciones_compartidas_sync',
  reglas_recurrencia: 'reglas_recurrencia_sync',
};

interface FilaRemotaSupabase {
  id: string;
  propietario_id: string;
  dispositivo_id: string;
  version: number;
  estado: 'ACTIVO' | 'ELIMINADO';
  estado_sincronizacion: 'PENDIENTE' | 'SINCRONIZADO' | 'CONFLICTO' | 'ERROR';
  huella_contenido: string;
  created_at: string;
  updated_at: string;
  eliminado_en: string | null;
  datos: unknown;
}

export class ClienteSupabasePrivado implements TransporteNubeRls {
  private readonly urlBase: string | null;
  private readonly publishableKey: string | null;
  private readonly emailPropietarioAutorizado: string | null;
  private readonly urlProduccionVercel: string | null;
  private sesionEnMemoria: SesionPropietarioSupabase | null = null;
  private readonly errorConfiguracion: string | null;

  constructor(opciones?: {
    url?: string | null;
    publishableKey?: string | null;
    emailPropietarioAutorizado?: string | null;
    urlProduccionVercel?: string | null;
  }) {
    const envMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    const url = opciones?.url ?? envMeta.VITE_SUPABASE_URL ?? null;
    const key = opciones?.publishableKey ?? envMeta.VITE_SUPABASE_PUBLISHABLE_KEY ?? null;
    const emailAut =
      opciones?.emailPropietarioAutorizado ??
      envMeta.VITE_PROPIETARIO_EMAIL_AUTORIZADO ??
      null;
    const urlVercelEnv =
      opciones?.urlProduccionVercel ??
      envMeta.VITE_VERCEL_PRODUCTION_URL ??
      (typeof window !== 'undefined' && window.location?.hostname?.endsWith('.vercel.app')
        ? window.location.origin
        : null);
    this.urlProduccionVercel = urlVercelEnv ? urlVercelEnv.trim().replace(/\/+$/, '') : null;

    if (!url && !key) {
      this.urlBase = null;
      this.publishableKey = null;
      this.emailPropietarioAutorizado = emailAut;
      this.errorConfiguracion = null;
      return;
    }

    const validacion = validarClavePublicaSupabaseEnCliente(url, key);
    if (!validacion.valida) {
      this.urlBase = null;
      this.publishableKey = null;
      this.emailPropietarioAutorizado = emailAut;
      this.errorConfiguracion = validacion.motivoRechazo ?? 'Configuración de Supabase inválida.';
      return;
    }

    this.urlBase = url!.trim().replace(/\/+$/, '');
    this.publishableKey = key!.trim();
    this.emailPropietarioAutorizado = emailAut ? emailAut.trim().toLowerCase() : null;
    this.errorConfiguracion = null;
  }

  estaConfigurado(): boolean {
    return Boolean(this.urlBase && this.publishableKey && !this.errorConfiguracion);
  }

  obtenerErrorConfiguracion(): string | null {
    return this.errorConfiguracion;
  }

  obtenerSesionActual(): SesionPropietarioSupabase | null {
    return this.sesionEnMemoria;
  }

  /**
   * Devuelve la configuración validada del subdominio gratuito `*.vercel.app`
   * y las URLs de redirección exactas para Supabase Auth (sin dominios propios ni DNS).
   */
  obtenerConfiguracionDominioVercel(
    urlAlternativa?: string,
  ): ConfiguracionDominioGratuitoVercel {
    const candidata =
      urlAlternativa ??
      this.urlProduccionVercel ??
      'https://mis-cuentas.vercel.app';
    return validarYConstruirConfiguracionDominioVercel(candidata);
  }

  obtenerPrincipioSeguridadUrl(): string {
    return PRINCIPIO_SEGURIDAD_URL_NO_ES_SECRETO;
  }

  /**
   * Restaura en memoria una sesión de propietario previamente persistida en IndexedDB
   * tras cerrar la aplicación o reiniciar el celular.
   */
  restaurarSesion(sesion: SesionPropietarioSupabase | null): void {
    this.sesionEnMemoria = sesion;
  }

  /**
   * Si el accessToken está próximo a expirar o expiró durante días sin conexión
   * en un viaje y existe `refreshToken`, renueva automáticamente la sesión contra
   * Supabase Cloud (`/auth/v1/token?grant_type=refresh_token`).
   */
  async renovarSesionSiExpirada(): Promise<SesionPropietarioSupabase | null> {
    if (!this.sesionEnMemoria) return null;
    const ahoraSeg = Math.floor(Date.now() / 1000);
    if (this.sesionEnMemoria.expiraEnEpochSegundos > ahoraSeg + 60) {
      return this.sesionEnMemoria;
    }
    if (!this.sesionEnMemoria.refreshToken || !this.urlBase || !this.publishableKey) {
      return this.sesionEnMemoria;
    }

    const resp = await fetch(`${this.urlBase}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        refresh_token: this.sesionEnMemoria.refreshToken,
      }),
    });

    if (!resp.ok) {
      return this.sesionEnMemoria;
    }

    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { id?: string; email?: string };
    };

    if (!data.access_token) {
      return this.sesionEnMemoria;
    }

    const renovada: SesionPropietarioSupabase = {
      uid: data.user?.id ?? this.sesionEnMemoria.uid,
      email: data.user?.email ?? this.sesionEnMemoria.email,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? this.sesionEnMemoria.refreshToken,
      expiraEnEpochSegundos: ahoraSeg + (data.expires_in ?? 3600),
    };
    this.sesionEnMemoria = renovada;
    return renovada;
  }

  /**
   * Inicia sesión privada mediante Supabase Auth (`/auth/v1/token?grant_type=password`).
   * Si se configuró `VITE_PROPIETARIO_EMAIL_AUTORIZADO`, rechaza cualquier otro correo.
   */
  async iniciarSesionConContrasena(
    email: string,
    contrasena: string,
  ): Promise<SesionPropietarioSupabase> {
    if (!this.estaConfigurado() || !this.urlBase || !this.publishableKey) {
      throw new Error(
        this.errorConfiguracion ??
          'Supabase no está configurado en las variables de entorno (.env).',
      );
    }

    const correoLimpio = email.trim().toLowerCase();
    if (
      this.emailPropietarioAutorizado &&
      correoLimpio !== this.emailPropietarioAutorizado
    ) {
      throw new Error(
        'ACCESO_DENEGADO: Esta aplicación es de uso privado y personal; el correo ingresado no corresponde al propietario autorizado.',
      );
    }

    const resp = await fetch(`${this.urlBase}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: this.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: correoLimpio,
        password: contrasena,
      }),
    });

    if (!resp.ok) {
      throw new Error('Credenciales de Supabase Auth inválidas o cuenta no autorizada.');
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      user?: { id: string; email?: string };
    };

    if (!data.access_token || !data.user?.id) {
      throw new Error('Respuesta de autenticación incompleta.');
    }

    const sesion: SesionPropietarioSupabase = {
      uid: data.user.id,
      email: data.user.email ?? correoLimpio,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiraEnEpochSegundos:
        Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };

    this.sesionEnMemoria = sesion;
    return sesion;
  }

  /** Cierra la sesión activa en Supabase Auth y limpia inmediatamente el token en memoria. */
  async cerrarSesion(): Promise<void> {
    const sesion = this.sesionEnMemoria;
    this.sesionEnMemoria = null;
    if (!sesion || !this.urlBase || !this.publishableKey) return;
    try {
      await fetch(`${this.urlBase}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: this.publishableKey,
          Authorization: `Bearer ${sesion.accessToken}`,
        },
      });
    } catch {
      // El token en memoria ya fue revocado localmente
    }
  }

  /**
   * Procesa el retorno de una redirección de Supabase Auth (confirmación de correo,
   * recuperación de contraseña o enlace de propietario con `#access_token=...` en el hash),
   * valida que pertenezca exclusivamente al propietario autorizado y establece la sesión.
   */
  async procesarRetornoRedireccionAuth(
    urlCompletaOFragmento: string,
  ): Promise<SesionPropietarioSupabase | null> {
    if (urlCompletaOFragmento.startsWith('http://') || urlCompletaOFragmento.startsWith('https://')) {
      const validacionVercel = validarYConstruirConfiguracionDominioVercel(urlCompletaOFragmento);
      if (!validacionVercel.valida) {
        throw new Error(
          validacionVercel.motivoRechazo ??
            'REDIRECCION_NO_PERMITIDA: La redirección de autenticación de producción solo se permite hacia el subdominio HTTPS gratuito *.vercel.app.',
        );
      }
    }
    const idxHash = urlCompletaOFragmento.indexOf('#');
    const fragmento =
      idxHash >= 0
        ? urlCompletaOFragmento.slice(idxHash + 1)
        : urlCompletaOFragmento.replace(/^#/, '');
    if (!fragmento || !fragmento.includes('access_token=')) {
      return null;
    }

    const params = new URLSearchParams(fragmento);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn = Number(params.get('expires_in') ?? '3600');
    if (!accessToken) return null;

    let uid: string | null = null;
    let email: string | null = null;

    if (this.estaConfigurado() && this.urlBase && this.publishableKey) {
      try {
        const resp = await fetch(`${this.urlBase}/auth/v1/user`, {
          method: 'GET',
          headers: {
            apikey: this.publishableKey,
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (resp.ok) {
          const userObj = (await resp.json()) as { id?: string; email?: string };
          uid = userObj.id ?? null;
          email = userObj.email ?? null;
        }
      } catch {
        // Respaldo con decodificación local de claims si no hay red en ese milisegundo
      }
    }

    if (!uid || !email) {
      const partes = accessToken.split('.');
      if (partes.length === 3) {
        try {
          const b64 = partes[1]!.replace(/-/g, '+').replace(/_/g, '/');
          const json =
            typeof atob === 'function'
              ? atob(b64)
              : Buffer.from(b64, 'base64').toString('utf8');
          const payload = JSON.parse(json) as { sub?: string; email?: string };
          uid = uid ?? payload.sub ?? null;
          email = email ?? payload.email ?? null;
        } catch {
          // Ignorar si no es un JWT estándar
        }
      }
    }

    if (!uid || !email) {
      throw new Error('REDIRECCION_AUTH_INVALIDA: No se pudo verificar la identidad del propietario en el token de retorno.');
    }

    const correoLimpio = email.trim().toLowerCase();
    if (
      this.emailPropietarioAutorizado &&
      correoLimpio !== this.emailPropietarioAutorizado
    ) {
      this.sesionEnMemoria = null;
      throw new Error(
        'ACCESO_DENEGADO: El enlace de autenticación no corresponde al correo del propietario autorizado.',
      );
    }

    const sesion: SesionPropietarioSupabase = {
      uid,
      email: correoLimpio,
      accessToken,
      refreshToken: refreshToken ?? null,
      expiraEnEpochSegundos:
        Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600),
    };
    this.sesionEnMemoria = sesion;
    return sesion;
  }

  private cabecerasAutenticadas(): Record<string, string> {
    if (!this.publishableKey || !this.sesionEnMemoria) {
      throw new Error('RLS_NO_AUTENTICADO: Inicie sesión con su cuenta de propietario para sincronizar con Supabase.');
    }
    return {
      apikey: this.publishableKey,
      Authorization: `Bearer ${this.sesionEnMemoria.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async empujarSobres(
    authUid: string | null,
    sobres: readonly SobreSincronizacion[],
  ): Promise<{
    aplicados: SobreSincronizacion[];
    conflictos: ConflictoSincronizacion[];
  }> {
    await this.renovarSesionSiExpirada();
    if (!this.urlBase || !this.sesionEnMemoria || !authUid) {
      throw new Error('RLS_NO_AUTENTICADO: Sesión de Supabase no iniciada.');
    }
    if (authUid !== this.sesionEnMemoria.uid) {
      throw new Error('RLS_VIOLACION_PROPIETARIO: El UID de sesión no coincide con el propietario.');
    }

    const aplicados: SobreSincronizacion[] = [];
    const conflictos: ConflictoSincronizacion[] = [];

    for (const sobre of sobres) {
      const tabla = TABLA_POR_ENTIDAD[sobre.entidad];
      // 1. Consultar versión actual en Supabase bajo RLS
      const urlConsulta = `${this.urlBase}/rest/v1/${tabla}?id=eq.${encodeURIComponent(
        sobre.id,
      )}&select=*`;
      const resGet = await fetch(urlConsulta, {
        method: 'GET',
        headers: this.cabecerasAutenticadas(),
      });
      if (!resGet.ok) {
        throw new Error(`Error al consultar ${tabla} en Supabase (${resGet.status}).`);
      }
      const filas = (await resGet.json()) as FilaRemotaSupabase[];
      const filaRemota = filas[0] ?? null;

      const sobreRemoto: SobreSincronizacion | null = filaRemota
        ? {
            id: filaRemota.id,
            entidad: sobre.entidad,
            propietarioId: filaRemota.propietario_id,
            dispositivoId: filaRemota.dispositivo_id,
            createdAt: filaRemota.created_at,
            updatedAt: filaRemota.updated_at,
            eliminadoEn: filaRemota.eliminado_en,
            estado: filaRemota.estado,
            version: filaRemota.version,
            versionBaseConocida: filaRemota.version,
            estadoSincronizacion: 'SINCRONIZADO',
            huellaContenido: filaRemota.huella_contenido,
            datos: filaRemota.datos,
          }
        : null;

      const decision = evaluarCambioConcurrente(sobre, sobreRemoto);
      if (decision.resultado === 'IDEMPOTENTE_YA_SINCRONIZADO') {
        aplicados.push(decision.sobreActual);
        continue;
      }
      if (decision.resultado === 'CONFLICTO_DETECTADO') {
        conflictos.push(decision.conflicto);
        continue;
      }

      const paraGuardar = decision.sobreParaGuardar;
      const cuerpoFila: Record<string, unknown> = {
        id: paraGuardar.id,
        propietario_id: authUid,
        dispositivo_id: paraGuardar.dispositivoId,
        version: paraGuardar.version,
        estado: paraGuardar.estado,
        estado_sincronizacion: 'SINCRONIZADO',
        huella_contenido: paraGuardar.huellaContenido,
        created_at: paraGuardar.createdAt,
        updated_at: ahoraISO(),
        eliminado_en: paraGuardar.eliminadoEn,
        datos: paraGuardar.datos,
      };

      if (sobre.entidad === 'transacciones') {
        const d = paraGuardar.datos as Record<string, unknown>;
        cuerpoFila.fecha_movimiento = String(d.fechaMovimiento ?? '2026-01-01');
        cuerpoFila.tipo_movimiento = String(d.tipo ?? 'GASTO');
        cuerpoFila.monto_centimos =
          typeof d.montoCentimos === 'number' && Number.isFinite(d.montoCentimos)
            ? Math.trunc(d.montoCentimos)
            : 0;
        cuerpoFila.moneda = 'PEN';
        const aud = (d.auditoria ?? {}) as Record<string, unknown>;
        cuerpoFila.origen = String(aud.origen ?? 'MANUAL');
      }

      const resUpsert = await fetch(
        `${this.urlBase}/rest/v1/${tabla}?on_conflict=propietario_id,id`,
        {
          method: 'POST',
          headers: {
            ...this.cabecerasAutenticadas(),
            Prefer: 'resolution=merge-duplicates,return=representation',
          },
          body: JSON.stringify(cuerpoFila),
        },
      );

      if (!resUpsert.ok) {
        throw new Error(`Error al sincronizar registro en ${tabla} (${resUpsert.status}).`);
      }

      aplicados.push(paraGuardar);
    }

    return { aplicados, conflictos };
  }

  async descargarSobresDesde(
    authUid: string | null,
    cursorIso: string | null,
  ): Promise<{
    cursorNuevoIso: string;
    sobres: SobreSincronizacion[];
  }> {
    await this.renovarSesionSiExpirada();
    if (!this.urlBase || !this.sesionEnMemoria || !authUid) {
      throw new Error('RLS_NO_AUTENTICADO: Sesión de Supabase no iniciada.');
    }

    const sobres: SobreSincronizacion[] = [];
    for (const entidad of ENTIDADES_SINCRONIZABLES) {
      const tabla = TABLA_POR_ENTIDAD[entidad];
      const filtroCursor = cursorIso
        ? `&updated_at=gte.${encodeURIComponent(cursorIso)}`
        : '';
      const url = `${this.urlBase}/rest/v1/${tabla}?select=*${filtroCursor}&order=updated_at.asc`;
      const res = await fetch(url, {
        method: 'GET',
        headers: this.cabecerasAutenticadas(),
      });
      if (!res.ok) {
        throw new Error(`Error al descargar ${tabla} desde Supabase (${res.status}).`);
      }
      const filas = (await res.json()) as FilaRemotaSupabase[];
      for (const f of filas) {
        if (f.propietario_id !== authUid) continue;
        sobres.push({
          id: f.id,
          entidad,
          propietarioId: f.propietario_id,
          dispositivoId: f.dispositivo_id,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
          eliminadoEn: f.eliminado_en,
          estado: f.estado,
          version: f.version,
          versionBaseConocida: f.version,
          estadoSincronizacion: 'SINCRONIZADO',
          huellaContenido: f.huella_contenido,
          datos: f.datos,
        });
      }
    }

    sobres.sort((a, b) => (a.updatedAt <= b.updatedAt ? -1 : 1));
    const cursorNuevoIso =
      sobres.length > 0 ? sobres[sobres.length - 1]!.updatedAt : (cursorIso ?? ahoraISO());
    return { cursorNuevoIso, sobres };
  }
}
