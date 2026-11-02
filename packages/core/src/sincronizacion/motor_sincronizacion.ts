/**
 * Fase 5 — Motor de Sincronización Multidispositivo (PC ↔ Nube ↔ Celular).
 *
 * Garantiza:
 *  - UUID estable, created_at, updated_at, versión monótona, estado de sincronización
 *    e identificador del propietario (`propietarioId`).
 *  - Cola local de operaciones pendientes con compactación que preserva `versionBaseConocida`.
 *  - Operaciones idempotentes y control estricto de duplicados por ID y huella FNV-1a.
 *  - Detección de conflictos en modificaciones simultáneas (p. ej. PC y celular editan
 *    o eliminan el mismo movimiento mientras uno estaba offline) SIN sobrescribir
 *    silenciosamente ningún cambio.
 *  - Autorización Row Level Security (RLS): ningún usuario distinto de `propietarioId`
 *    puede leer ni escribir registros ajenos.
 */
import { ahoraISO } from '../fechas';

export const ENTIDADES_SINCRONIZABLES = [
  'cuentas',
  'categorias',
  'eventos',
  'presupuestos',
  'transacciones',
  'gastos_planificados',
  'gastos_compartidos',
  'liquidaciones_compartidas',
  'reglas_recurrencia',
] as const;

export type NombreEntidadSincronizable = (typeof ENTIDADES_SINCRONIZABLES)[number];

export type EstadoSincronizacionRegistro =
  | 'PENDIENTE'
  | 'SINCRONIZADO'
  | 'CONFLICTO'
  | 'ERROR';

export interface SobreSincronizacion<T = unknown> {
  /** UUID estable del registro. */
  id: string;
  entidad: NombreEntidadSincronizable;
  /** Identificador del propietario (auth.uid() en Supabase). */
  propietarioId: string;
  /** Identificador del dispositivo que emitió la revisión (p. ej. pc-1, celular-1). */
  dispositivoId: string;
  createdAt: string;
  updatedAt: string;
  eliminadoEn: string | null;
  estado: 'ACTIVO' | 'ELIMINADO';
  /** Versión actual del registro (>= 1). */
  version: number;
  /**
   * Versión base sobre la cual se aplicó la modificación en este dispositivo
   * (0 si fue creado nuevo localmente; >= 1 si partió de una versión ya sincronizada).
   */
  versionBaseConocida: number;
  estadoSincronizacion: EstadoSincronizacionRegistro;
  /** Huella determinista del contenido de negocio (excluyendo timestamps efímeros). */
  huellaContenido: string;
  datos: T;
}

export type MotivoConflictoSincronizacion =
  | 'EDICION_SIMULTANEA'
  | 'EDICION_VS_ELIMINACION'
  | 'ELIMINACION_VS_EDICION';

export interface ConflictoSincronizacion<T = unknown> {
  id: string;
  entidad: NombreEntidadSincronizable;
  registroId: string;
  motivo: MotivoConflictoSincronizacion;
  detectadoEn: string;
  sobreLocal: SobreSincronizacion<T>;
  sobreRemoto: SobreSincronizacion<T>;
  resuelto: boolean;
  resolucionAplicada?: EstrategiaResolucionConflicto;
}

export type EstrategiaResolucionConflicto =
  | 'CONSERVAR_LOCAL'
  | 'CONSERVAR_REMOTO';

/** Calcula una huella FNV-1a determinista sobre los campos de negocio de un registro. */
export function calcularHuellaContenidoSincronizable(datos: unknown): string {
  const normalizar = (val: unknown): unknown => {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(normalizar);
    const obj = val as Record<string, unknown>;
    const ordenado: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      // Omitimos metadatos de versión/actualización para comparar el valor contable real
      if (k === 'auditoria' && typeof obj[k] === 'object' && obj[k] !== null) {
        const aud = obj[k] as Record<string, unknown>;
        ordenado[k] = {
          origen: aud.origen ?? 'MANUAL',
        };
        continue;
      }
      if (k === 'actualizadoEn' || k === 'updatedAt') continue;
      ordenado[k] = normalizar(obj[k]);
    }
    return ordenado;
  };

  const json = JSON.stringify(normalizar(datos));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Extrae metadatos estándar (`id`, `estado`, `creadoEn`, `actualizadoEn`, `eliminadoEn`, `version`)
 * de un registro del dominio y construye su `SobreSincronizacion`.
 */
export function construirSobreSincronizacion<T extends Record<string, unknown>>(params: {
  entidad: NombreEntidadSincronizable;
  registro: T;
  propietarioId: string;
  dispositivoId: string;
  versionBaseConocida: number;
  estadoSincronizacion?: EstadoSincronizacionRegistro;
}): SobreSincronizacion<T> {
  const reg = params.registro;
  const aud = (reg.auditoria ?? {}) as Record<string, unknown>;
  const id = String(reg.id ?? '');
  if (!id) {
    throw new Error('Todo registro sincronizable requiere un UUID estable en `id`.');
  }

  const estado = reg.estado === 'ELIMINADO' ? 'ELIMINADO' : 'ACTIVO';
  const createdAt =
    typeof aud.creadoEn === 'string'
      ? aud.creadoEn
      : typeof reg.creadoEn === 'string'
        ? reg.creadoEn
        : ahoraISO();
  const updatedAt =
    typeof aud.actualizadoEn === 'string'
      ? aud.actualizadoEn
      : typeof reg.actualizadoEn === 'string'
        ? reg.actualizadoEn
        : createdAt;
  const eliminadoEn =
    typeof aud.eliminadoEn === 'string'
      ? aud.eliminadoEn
      : estado === 'ELIMINADO'
        ? updatedAt
        : null;
  const version =
    typeof aud.version === 'number' && aud.version >= 1
      ? aud.version
      : params.versionBaseConocida + 1;

  return {
    id,
    entidad: params.entidad,
    propietarioId: params.propietarioId,
    dispositivoId: params.dispositivoId,
    createdAt,
    updatedAt,
    eliminadoEn,
    estado,
    version,
    versionBaseConocida: params.versionBaseConocida,
    estadoSincronizacion: params.estadoSincronizacion ?? 'PENDIENTE',
    huellaContenido: calcularHuellaContenidoSincronizable(reg),
    datos: reg,
  };
}

/**
 * Compacta una cola local de operaciones pendientes para que múltiples ediciones
 * realizadas offline sobre el mismo `(entidad, id)` se envíen como una sola operación
 * conservando la `versionBaseConocida` original previa a las ediciones offline.
 */
export function compactarColaSincronizacion(
  cola: readonly SobreSincronizacion[],
): SobreSincronizacion[] {
  const mapa = new Map<string, SobreSincronizacion>();
  for (const item of cola) {
    const llave = `${item.entidad}:${item.id}`;
    const previo = mapa.get(llave);
    if (!previo) {
      mapa.set(llave, item);
    } else {
      mapa.set(llave, {
        ...item,
        createdAt: previo.createdAt,
        versionBaseConocida: previo.versionBaseConocida,
        version: Math.max(previo.version, item.version),
      });
    }
  }
  return [...mapa.values()];
}

/** Calcula el tiempo de espera con backoff exponencial acotado para reintentos de red. */
export function calcularRetrasoReintentoMs(intento: number): number {
  const exp = Math.min(6, Math.max(0, intento));
  return Math.min(30_000, 500 * Math.pow(2, exp));
}

/**
 * Evalúa si un cambio entrante o saliente entra en conflicto con otra versión
 * modificada concurrentemente desde otro dispositivo.
 */
export function evaluarCambioConcurrente<T>(
  sobreLocal: SobreSincronizacion<T>,
  sobreRemoto: SobreSincronizacion<T> | null,
):
  | { resultado: 'APLICAR_LOCAL_A_NUBE'; sobreParaGuardar: SobreSincronizacion<T> }
  | { resultado: 'IDEMPOTENTE_YA_SINCRONIZADO'; sobreActual: SobreSincronizacion<T> }
  | { resultado: 'CONFLICTO_DETECTADO'; conflicto: ConflictoSincronizacion<T> } {
  // 1. Si el registro no existe aún en la nube: se inserta limpiamente
  if (!sobreRemoto) {
    return {
      resultado: 'APLICAR_LOCAL_A_NUBE',
      sobreParaGuardar: {
        ...sobreLocal,
        version: Math.max(1, sobreLocal.version),
        versionBaseConocida: Math.max(1, sobreLocal.version),
        estadoSincronizacion: 'SINCRONIZADO',
      },
    };
  }

  // 2. Operación idempotente: si la huella de negocio y el estado coinciden exactamente,
  //    es un reintento de un envío que ya había llegado; no hay conflicto ni duplicación.
  if (
    sobreLocal.huellaContenido === sobreRemoto.huellaContenido &&
    sobreLocal.estado === sobreRemoto.estado
  ) {
    return {
      resultado: 'IDEMPOTENTE_YA_SINCRONIZADO',
      sobreActual: {
        ...sobreRemoto,
        estadoSincronizacion: 'SINCRONIZADO',
      },
    };
  }

  // 3. Si la versión base conocida por el dispositivo local coincide con la versión
  //    actual en la nube (nadie más modificó el registro en el ínterin), es una
  //    evolución lineal válida: avanzamos a versionRemota + 1.
  if (sobreLocal.versionBaseConocida === sobreRemoto.version) {
    const nuevaVersion = sobreRemoto.version + 1;
    return {
      resultado: 'APLICAR_LOCAL_A_NUBE',
      sobreParaGuardar: {
        ...sobreLocal,
        createdAt: sobreRemoto.createdAt,
        version: nuevaVersion,
        versionBaseConocida: nuevaVersion,
        estadoSincronizacion: 'SINCRONIZADO',
      },
    };
  }

  // 4. Si otro dispositivo (o una sesión distinta) modificó el registro en la nube
  //    (sobreRemoto.version > sobreLocal.versionBaseConocida) y el contenido difiere:
  //    PROHIBIDO sobrescribir silenciosamente. Se levanta un conflicto explícito.
  let motivo: MotivoConflictoSincronizacion = 'EDICION_SIMULTANEA';
  if (sobreLocal.estado === 'ACTIVO' && sobreRemoto.estado === 'ELIMINADO') {
    motivo = 'EDICION_VS_ELIMINACION';
  } else if (sobreLocal.estado === 'ELIMINADO' && sobreRemoto.estado === 'ACTIVO') {
    motivo = 'ELIMINACION_VS_EDICION';
  }

  return {
    resultado: 'CONFLICTO_DETECTADO',
    conflicto: {
      id: `conf-${sobreLocal.entidad}-${sobreLocal.id}-${sobreRemoto.version}`,
      entidad: sobreLocal.entidad,
      registroId: sobreLocal.id,
      motivo,
      detectadoEn: ahoraISO(),
      sobreLocal: { ...sobreLocal, estadoSincronizacion: 'CONFLICTO' },
      sobreRemoto: { ...sobreRemoto, estadoSincronizacion: 'SINCRONIZADO' },
      resuelto: false,
    },
  };
}

/**
 * Resuelve de manera explícita y auditada un conflicto entre dos dispositivos.
 */
export function construirSobreResueltoDeConflicto<T extends Record<string, unknown>>(
  conflicto: ConflictoSincronizacion<T>,
  estrategia: EstrategiaResolucionConflicto,
  dispositivoResolutorId: string,
): SobreSincronizacion<T> {
  const versionNueva =
    Math.max(conflicto.sobreLocal.version, conflicto.sobreRemoto.version) + 1;
  const ahora = ahoraISO();

  if (estrategia === 'CONSERVAR_REMOTO') {
    return {
      ...conflicto.sobreRemoto,
      versionBaseConocida: conflicto.sobreRemoto.version,
      estadoSincronizacion: 'SINCRONIZADO',
    };
  }

  const datosBase: Record<string, unknown> = {
    ...(conflicto.sobreLocal.datos as Record<string, unknown>),
  };
  if (typeof datosBase.auditoria === 'object' && datosBase.auditoria !== null) {
    datosBase.auditoria = {
      ...(datosBase.auditoria as Record<string, unknown>),
      actualizadoEn: ahora,
      version: versionNueva,
    };
  }

  return {
    ...conflicto.sobreLocal,
    dispositivoId: dispositivoResolutorId,
    updatedAt: ahora,
    version: versionNueva,
    versionBaseConocida: conflicto.sobreRemoto.version,
    estadoSincronizacion: 'PENDIENTE',
    huellaContenido: calcularHuellaContenidoSincronizable(datosBase),
    datos: datosBase as T,
  };
}

// ───────────────────────── PUERTO CLOUD Y SIMULADOR CON RLS ESTRICTO ─────────────────────────

export interface TransporteNubeRls {
  /** Empuja un lote de sobres en nombre del usuario autenticado `authUid`. */
  empujarSobres(
    authUid: string | null,
    sobres: readonly SobreSincronizacion[],
  ): Promise<{
    aplicados: SobreSincronizacion[];
    conflictos: ConflictoSincronizacion[];
  }>;

  /** Descarga todos los sobres del propietario `authUid` actualizados después de `cursorIso`. */
  descargarSobresDesde(
    authUid: string | null,
    cursorIso: string | null,
  ): Promise<{
    cursorNuevoIso: string;
    sobres: SobreSincronizacion[];
  }>;
}

/**
 * Implementación de referencia de una nube Supabase/PostgreSQL con Row Level Security (RLS)
 * estricto (`auth.uid() === propietario_id`), control de versiones optimista e idempotencia.
 * Permite sincronizar múltiples clientes reales en memoria (p. ej. Nodo PC y Nodo Celular)
 * y verificar todas las garantías de seguridad y concurrencia.
 */
export class AlmacenNubeConRls implements TransporteNubeRls {
  private readonly registrosPorPropietario = new Map<string, SobreSincronizacion>();
  private readonly uidPropietarioAutorizado: string | null;

  constructor(opciones?: { uidPropietarioAutorizado?: string }) {
    this.uidPropietarioAutorizado = opciones?.uidPropietarioAutorizado ?? null;
  }

  private verificarAutorizacionRls(authUid: string | null, propietarioRegistro: string): void {
    if (!authUid || !authUid.trim()) {
      throw new Error('RLS_NO_AUTENTICADO: Acceso denegado. Se requiere sesión autenticada (auth.uid()).');
    }
    if (this.uidPropietarioAutorizado && authUid !== this.uidPropietarioAutorizado) {
      throw new Error(
        'RLS_CUENTA_NO_AUTORIZADA: Esta aplicación es de uso privado y personal; la cuenta no está autorizada.',
      );
    }
    if (authUid !== propietarioRegistro) {
      throw new Error(
        'RLS_VIOLACION_PROPIETARIO: Row Level Security bloqueó el acceso a un registro cuyo propietario_id no coincide con auth.uid().',
      );
    }
  }

  async empujarSobres(
    authUid: string | null,
    sobres: readonly SobreSincronizacion[],
  ): Promise<{
    aplicados: SobreSincronizacion[];
    conflictos: ConflictoSincronizacion[];
  }> {
    if (!authUid) {
      throw new Error('RLS_NO_AUTENTICADO: Acceso denegado. Se requiere sesión autenticada.');
    }
    if (this.uidPropietarioAutorizado && authUid !== this.uidPropietarioAutorizado) {
      throw new Error(
        'RLS_CUENTA_NO_AUTORIZADA: Solo la cuenta autorizada del propietario puede modificar registros.',
      );
    }

    const aplicados: SobreSincronizacion[] = [];
    const conflictos: ConflictoSincronizacion[] = [];

    for (const sobre of compactarColaSincronizacion(sobres)) {
      this.verificarAutorizacionRls(authUid, sobre.propietarioId);
      const llave = `${sobre.propietarioId}|${sobre.entidad}|${sobre.id}`;
      const remoto = this.registrosPorPropietario.get(llave) ?? null;

      const decision = evaluarCambioConcurrente(sobre, remoto);
      if (decision.resultado === 'APLICAR_LOCAL_A_NUBE') {
        const guardado: SobreSincronizacion = {
          ...decision.sobreParaGuardar,
          updatedAt: ahoraISO(),
        };
        this.registrosPorPropietario.set(llave, guardado);
        aplicados.push(guardado);
      } else if (decision.resultado === 'IDEMPOTENTE_YA_SINCRONIZADO') {
        aplicados.push(decision.sobreActual);
      } else {
        conflictos.push(decision.conflicto);
      }
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
    if (!authUid) {
      throw new Error('RLS_NO_AUTENTICADO: Acceso denegado. Se requiere sesión autenticada.');
    }
    if (this.uidPropietarioAutorizado && authUid !== this.uidPropietarioAutorizado) {
      throw new Error(
        'RLS_CUENTA_NO_AUTORIZADA: Solo la cuenta autorizada del propietario puede consultar registros.',
      );
    }

    const sobres: SobreSincronizacion[] = [];
    for (const reg of this.registrosPorPropietario.values()) {
      // Política SELECT RLS: solo devuelve filas donde reg.propietarioId === authUid
      if (reg.propietarioId !== authUid) continue;
      if (cursorIso && reg.updatedAt < cursorIso) continue;
      sobres.push(reg);
    }

    sobres.sort((a, b) => (a.updatedAt <= b.updatedAt ? -1 : 1));
    const cursorNuevoIso =
      sobres.length > 0 ? sobres[sobres.length - 1]!.updatedAt : (cursorIso ?? ahoraISO());

    return { cursorNuevoIso, sobres };
  }
}

/**
 * Nodo cliente de sincronización (representa una instancia en PC o en Celular)
 * con soporte completo para trabajo offline, cola pendiente, reconexión,
 * detección de conflictos sin sobrescritura silenciosa y resolución auditada.
 */
export class NodoSincronizacionDispositivo {
  readonly dispositivoId: string;
  readonly propietarioId: string;
  private conectado = true;
  private ultimoCursorIso: string | null = null;
  private ultimaSincronizacionIso: string | null = null;
  private readonly almacenLocal = new Map<string, SobreSincronizacion>();
  private colaPendiente: SobreSincronizacion[] = [];
  private readonly conflictosActivos = new Map<string, ConflictoSincronizacion>();
  private ultimoError: string | null = null;

  constructor(params: { dispositivoId: string; propietarioId: string; conectadoInicial?: boolean }) {
    this.dispositivoId = params.dispositivoId;
    this.propietarioId = params.propietarioId;
    this.conectado = params.conectadoInicial ?? true;
  }

  establecerConexion(enLinea: boolean): void {
    this.conectado = enLinea;
  }

  estaConectado(): boolean {
    return this.conectado;
  }

  obtenerEstadoResumen(): {
    conectado: boolean;
    ultimaSincronizacionIso: string | null;
    operacionesPendientes: number;
    conflictosActivos: number;
    ultimoError: string | null;
  } {
    return {
      conectado: this.conectado,
      ultimaSincronizacionIso: this.ultimaSincronizacionIso,
      operacionesPendientes: this.colaPendiente.length,
      conflictosActivos: this.conflictosActivos.size,
      ultimoError: this.ultimoError,
    };
  }

  /**
   * Registra o modifica localmente un registro (funciona tanto online como 100% offline).
   */
  guardarLocalmente<T extends Record<string, unknown>>(
    entidad: NombreEntidadSincronizable,
    registro: T,
  ): SobreSincronizacion<T> {
    const id = String(registro.id ?? '');
    const llave = `${entidad}:${id}`;
    const previoLocal = this.almacenLocal.get(llave);

    // Si el registro ya estaba sincronizado antes, la versión base conocida es esa versión sincronizada;
    // si ya estaba pendiente de sincronización offline, preservamos su versionBaseConocida original.
    const versionBaseConocida = previoLocal
      ? previoLocal.estadoSincronizacion === 'SINCRONIZADO'
        ? previoLocal.version
        : previoLocal.versionBaseConocida
      : 0;

    const sobre = construirSobreSincronizacion({
      entidad,
      registro,
      propietarioId: this.propietarioId,
      dispositivoId: this.dispositivoId,
      versionBaseConocida,
      estadoSincronizacion: 'PENDIENTE',
    });

    this.almacenLocal.set(llave, sobre);
    this.colaPendiente = compactarColaSincronizacion([...this.colaPendiente, sobre]);
    return sobre;
  }

  obtenerRegistroLocal<T = unknown>(
    entidad: NombreEntidadSincronizable,
    id: string,
  ): SobreSincronizacion<T> | undefined {
    return this.almacenLocal.get(`${entidad}:${id}`) as SobreSincronizacion<T> | undefined;
  }

  listarRegistrosLocales(entidad?: NombreEntidadSincronizable): SobreSincronizacion[] {
    const todos = [...this.almacenLocal.values()];
    return entidad ? todos.filter((r) => r.entidad === entidad) : todos;
  }

  listarConflictos(): ConflictoSincronizacion[] {
    return [...this.conflictosActivos.values()];
  }

  /**
   * Sincroniza bidireccionalmente (Push de cola pendiente + Pull incremental desde la nube).
   * Si el dispositivo está offline (`!this.conectado`), conserva intacta la cola pendiente.
   */
  async sincronizarConNube(transporte: TransporteNubeRls): Promise<{
    exito: boolean;
    enviados: number;
    recibidos: number;
    conflictosNuevos: number;
    error?: string;
  }> {
    if (!this.conectado) {
      this.ultimoError = 'Dispositivo sin conexión a internet (Modo Offline activo).';
      return {
        exito: false,
        enviados: 0,
        recibidos: 0,
        conflictosNuevos: 0,
        error: this.ultimoError,
      };
    }

    try {
      // 1. Primero descargamos novedades remotas para detectar posibles ediciones simultáneas
      const descargaPrevia = await transporte.descargarSobresDesde(
        this.propietarioId,
        this.ultimoCursorIso,
      );

      let recibidos = 0;
      let conflictosNuevos = 0;
      const llavesEnColaLocal = new Set(
        this.colaPendiente.map((c) => `${c.entidad}:${c.id}`),
      );

      for (const sobreRemoto of descargaPrevia.sobres) {
        const llave = `${sobreRemoto.entidad}:${sobreRemoto.id}`;
        const localActual = this.almacenLocal.get(llave);

        if (llavesEnColaLocal.has(llave) && localActual) {
          // El usuario modificó este mismo registro localmente mientras también cambió en la nube
          const evalConc = evaluarCambioConcurrente(localActual, sobreRemoto);
          if (evalConc.resultado === 'CONFLICTO_DETECTADO') {
            this.conflictosActivos.set(evalConc.conflicto.id, evalConc.conflicto);
            this.almacenLocal.set(llave, {
              ...localActual,
              estadoSincronizacion: 'CONFLICTO',
            });
            // Retirar de la cola automática hasta que el usuario resuelva el conflicto
            this.colaPendiente = this.colaPendiente.filter(
              (c) => `${c.entidad}:${c.id}` !== llave,
            );
            conflictosNuevos += 1;
            continue;
          } else if (evalConc.resultado === 'IDEMPOTENTE_YA_SINCRONIZADO') {
            this.almacenLocal.set(llave, evalConc.sobreActual);
            this.colaPendiente = this.colaPendiente.filter(
              (c) => `${c.entidad}:${c.id}` !== llave,
            );
            continue;
          }
        } else {
          // No hay edición local pendiente: aplicamos limpiamente la versión remota
          if (
            !localActual ||
            sobreRemoto.version >= localActual.version ||
            sobreRemoto.huellaContenido !== localActual.huellaContenido
          ) {
            this.almacenLocal.set(llave, {
              ...sobreRemoto,
              versionBaseConocida: sobreRemoto.version,
              estadoSincronizacion: 'SINCRONIZADO',
            });
            recibidos += 1;
          }
        }
      }

      // 2. Empujar operaciones pendientes que no estén en conflicto
      let enviados = 0;
      if (this.colaPendiente.length > 0) {
        const resPush = await transporte.empujarSobres(
          this.propietarioId,
          this.colaPendiente,
        );

        for (const ap of resPush.aplicados) {
          const llave = `${ap.entidad}:${ap.id}`;
          this.almacenLocal.set(llave, {
            ...ap,
            versionBaseConocida: ap.version,
            estadoSincronizacion: 'SINCRONIZADO',
          });
          enviados += 1;
        }

        for (const conf of resPush.conflictos) {
          this.conflictosActivos.set(conf.id, conf);
          const llave = `${conf.entidad}:${conf.registroId}`;
          const loc = this.almacenLocal.get(llave);
          if (loc) {
            this.almacenLocal.set(llave, { ...loc, estadoSincronizacion: 'CONFLICTO' });
          }
          conflictosNuevos += 1;
        }

        this.colaPendiente = [];
      }

      // 3. Actualizar cursor final tras el push
      const descargaFinal = await transporte.descargarSobresDesde(
        this.propietarioId,
        this.ultimoCursorIso,
      );
      this.ultimoCursorIso = descargaFinal.cursorNuevoIso;
      this.ultimaSincronizacionIso = ahoraISO();
      this.ultimoError = null;

      return {
        exito: true,
        enviados,
        recibidos,
        conflictosNuevos,
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.ultimoError = msg;
      return {
        exito: false,
        enviados: 0,
        recibidos: 0,
        conflictosNuevos: 0,
        error: msg,
      };
    }
  }

  /**
   * Resuelve un conflicto detectado aplicando la estrategia elegida por el usuario
   * (`CONSERVAR_LOCAL` o `CONSERVAR_REMOTO`).
   */
  resolverConflicto(
    conflictoId: string,
    estrategia: EstrategiaResolucionConflicto,
  ): SobreSincronizacion {
    const conf = this.conflictosActivos.get(conflictoId);
    if (!conf) {
      throw new Error(`El conflicto ${conflictoId} no existe o ya fue resuelto.`);
    }

    const sobreResuelto = construirSobreResueltoDeConflicto(
      conf as ConflictoSincronizacion<Record<string, unknown>>,
      estrategia,
      this.dispositivoId,
    );

    const llave = `${conf.entidad}:${conf.registroId}`;
    this.almacenLocal.set(llave, sobreResuelto);
    this.conflictosActivos.delete(conflictoId);

    if (estrategia === 'CONSERVAR_LOCAL') {
      this.colaPendiente = compactarColaSincronizacion([
        ...this.colaPendiente,
        sobreResuelto,
      ]);
    }

    return sobreResuelto;
  }
}
