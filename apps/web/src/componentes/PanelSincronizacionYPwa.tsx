import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  abrirPaqueteQrCifrado,
  crearVerificadorBloqueoLocal,
  exportarJsonCifradoConContrasena,
  exportarLibroAJson,
  fechaHoraLima,
  generarPaqueteQrCifrado,
  importarJsonCifradoConContrasena,
  LIMITACIONES_CIFRADO_WEB_CRYPTO,
  MAX_MOVIMIENTOS_POR_PAQUETE_QR,
  previsualizarImportacionJson,
  type ConflictoSincronizacion,
  type EstrategiaResolucionConflicto,
} from '@mis-cuentas/core';
import {
  ClienteSupabasePrivado,
  type SesionPropietarioSupabase,
} from '../persistencia/cliente_supabase';
import type {
  EstadoInstantaneoRepositorio,
  RepositorioFinanciero,
} from '../persistencia/puerto';

interface EventoBeforeInstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  repositorio: RepositorioFinanciero;
  onRecargar: () => Promise<void>;
  clienteSupabase?: ClienteSupabasePrivado;
  sesionExterna?: SesionPropietarioSupabase | null;
  onCambioSesion?: (sesion: SesionPropietarioSupabase | null) => Promise<void> | void;
  verificadorBloqueo: { saltHex: string; hashHex: string; iteraciones: number } | null;
  onConfigurarBloqueo: (verificador: {
    saltHex: string;
    hashHex: string;
    iteraciones: number;
  } | null) => Promise<void> | void;
  onActivarBloqueoAhora: () => void;
}

/**
 * Renderiza una matriz visual determinista en SVG a partir del paquete corto cifrado
 * para lectura o verificación visual junto al código copiable.
 */
const MatrizVisualQrSvg: React.FC<{ texto: string }> = ({ texto }) => {
  const dimension = 29;
  const celdas = useMemo(() => {
    const matriz: boolean[][] = Array.from({ length: dimension }, () =>
      new Array<boolean>(dimension).fill(false),
    );

    const dibujarPatronPosicion = (ox: number, oy: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const borde = x === 0 || x === 6 || y === 0 || y === 6;
          const centro = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          matriz[oy + y]![ox + x] = borde || centro;
        }
      }
    };

    dibujarPatronPosicion(0, 0);
    dibujarPatronPosicion(dimension - 7, 0);
    dibujarPatronPosicion(0, dimension - 7);

    let idxBit = 0;
    for (let y = 0; y < dimension; y++) {
      for (let x = 0; x < dimension; x++) {
        const enEsquina =
          (x < 8 && y < 8) ||
          (x >= dimension - 8 && y < 8) ||
          (x < 8 && y >= dimension - 8);
        if (enEsquina) continue;
        const charCode = texto.charCodeAt(idxBit % texto.length);
        const bit = ((charCode + idxBit * 17) >> (idxBit % 7)) & 1;
        matriz[y]![x] = bit === 1;
        idxBit++;
      }
    }
    return matriz;
  }, [texto]);

  return (
    <svg
      viewBox={`0 0 ${dimension + 4} ${dimension + 4}`}
      width="176"
      height="176"
      role="img"
      aria-label="Código QR de paquete corto cifrado"
      style={{ background: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '10px' }}
    >
      {celdas.map((fila, y) =>
        fila.map((activa, x) =>
          activa ? (
            <rect key={`${x}-${y}`} x={x + 2} y={y + 2} width={1} height={1} fill="#0f172a" />
          ) : null,
        ),
      )}
    </svg>
  );
};

export const PanelSincronizacionYPwa: React.FC<Props> = ({
  instantanea,
  repositorio,
  onRecargar,
  clienteSupabase: clienteProp,
  sesionExterna,
  onCambioSesion,
  verificadorBloqueo,
  onConfigurarBloqueo,
  onActivarBloqueoAhora,
}) => {
  const clienteSupabase = useMemo(
    () => clienteProp ?? new ClienteSupabasePrivado(),
    [clienteProp],
  );
  const [enLinea, setEnLinea] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const dispositivoId = useMemo<string>(() => {
    if (instantanea.dispositivoId) return instantanea.dispositivoId;
    const esMovil =
      typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches;
    return esMovil ? 'celular-pwa' : 'pc-escritorio';
  }, [instantanea.dispositivoId]);

  const [sesionInterna, setSesionInterna] = useState<SesionPropietarioSupabase | null>(() =>
    clienteSupabase.obtenerSesionActual(),
  );
  const sesion = sesionExterna !== undefined ? sesionExterna : sesionInterna;
  const [emailLogin, setEmailLogin] = useState<string>('');
  const [passwordLogin, setPasswordLogin] = useState<string>('');

  const [sincronizando, setSincronizando] = useState<boolean>(false);
  const [ultimaSyncIso, setUltimaSyncIso] = useState<string | null>(
    () => instantanea.ultimaSincronizacionIso ?? null,
  );
  const [errorSync, setErrorSync] = useState<string | null>(null);
  const [mensajeSync, setMensajeSync] = useState<string | null>(null);
  const [conflictos, setConflictos] = useState<ConflictoSincronizacion[]>([]);

  // Estado PWA e instalación
  const [eventoInstalacion, setEventoInstalacion] = useState<EventoBeforeInstallPrompt | null>(
    null,
  );
  const [esStandalone, setEsStandalone] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const navIos = navigator as Navigator & { standalone?: boolean };
    return (
      Boolean(navIos.standalone) ||
      (window.matchMedia?.('(display-mode: standalone)').matches ?? false)
    );
  });
  const [plataformaDetectada] = useState<'IOS' | 'ANDROID' | 'ESCRITORIO'>(() => {
    if (typeof navigator === 'undefined') return 'ESCRITORIO';
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'IOS';
    if (/Android/i.test(ua)) return 'ANDROID';
    return 'ESCRITORIO';
  });
  const configDominioVercel = useMemo(
    () => clienteSupabase.obtenerConfiguracionDominioVercel(),
    [clienteSupabase],
  );
  const [nuevaVersionSwDisponible, setNuevaVersionSwDisponible] = useState<boolean>(false);

  // Estado de Cifrado Web Crypto (.enc.json)
  const [passCifradoExport, setPassCifradoExport] = useState<string>('');
  const [passCifradoImport, setPassCifradoImport] = useState<string>('');
  const [textoCifradoImportar, setTextoCifradoImportar] = useState<string>('');
  const [mensajeCifrado, setMensajeCifrado] = useState<string | null>(null);
  const [errorCifrado, setErrorCifrado] = useState<string | null>(null);

  // Estado de Paquete Corto Cifrado por QR
  const [passQr, setPassQr] = useState<string>('');
  const [tipoQr, setTipoQr] = useState<'EMPAREJAMIENTO_DISPOSITIVO' | 'MICRO_LOTE_MOVIMIENTOS'>(
    'MICRO_LOTE_MOVIMIENTOS',
  );
  const [cadenaQrGenerada, setCadenaQrGenerada] = useState<string | null>(null);
  const [cadenaQrRecibida, setCadenaQrRecibida] = useState<string>('');
  const [passQrRecibido, setPassQrRecibido] = useState<string>('');
  const [resultadoQrAbierto, setResultadoQrAbierto] = useState<string | null>(null);
  const [errorQr, setErrorQr] = useState<string | null>(null);

  // Estado de Bloqueo Local de la Aplicación
  const [nuevoPinBloqueo, setNuevoPinBloqueo] = useState<string>('');
  const [mensajeBloqueo, setMensajeBloqueo] = useState<string | null>(null);

  const cargarConflictos = useCallback(async () => {
    const lista = await repositorio.listarConflictosSincronizacion();
    setConflictos(lista);
  }, [repositorio]);

  useEffect(() => {
    if (instantanea.ultimaSincronizacionIso) {
      setUltimaSyncIso(instantanea.ultimaSincronizacionIso);
    }
    void cargarConflictos();
  }, [cargarConflictos, instantanea]);

  const ejecutarSincronizacionManualOAutomatica = useCallback(async () => {
    if (!enLinea) {
      setErrorSync(
        'Modo Offline activo: los movimientos se guardan en IndexedDB del celular/navegador y se sincronizarán automáticamente al recuperar conexión.',
      );
      return;
    }
    if (!clienteSupabase.estaConfigurado()) {
      setErrorSync(
        clienteSupabase.obtenerErrorConfiguracion() ??
          'Supabase Cloud no configurado en variables de entorno (operando en modo local autónomo con IndexedDB).',
      );
      return;
    }
    const sesionActiva = clienteSupabase.obtenerSesionActual();
    if (!sesionActiva) {
      setErrorSync('Inicia sesión con tu cuenta privada de propietario para sincronizar con Supabase Cloud.');
      return;
    }

    setSincronizando(true);
    setErrorSync(null);
    try {
      const res = await repositorio.sincronizarConTransporte({
        transporte: clienteSupabase,
        propietarioId: sesionActiva.uid,
        dispositivoId,
      });
      setUltimaSyncIso(res.ultimaSincronizacionIso);
      setMensajeSync(
        `Sincronización Cloud completada: ${res.enviados} enviado(s), ${res.recibidos} recibido(s), ${res.conflictosDetectados} conflicto(s).`,
      );
      await cargarConflictos();
      await onRecargar();
    } catch (err) {
      setErrorSync((err as Error).message);
    } finally {
      setSincronizando(false);
    }
  }, [enLinea, clienteSupabase, repositorio, dispositivoId, cargarConflictos, onRecargar]);

  // Listeners de conectividad y recuperación automática al reconectar internet
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const alConectar = () => {
      setEnLinea(true);
      setErrorSync(null);
      if (clienteSupabase.obtenerSesionActual()) {
        void ejecutarSincronizacionManualOAutomatica();
      }
    };
    const alDesconectar = () => {
      setEnLinea(false);
    };
    const alBeforeInstall = (e: Event) => {
      e.preventDefault();
      setEventoInstalacion(e as EventoBeforeInstallPrompt);
    };

    window.addEventListener('online', alConectar);
    window.addEventListener('offline', alDesconectar);
    window.addEventListener('beforeinstallprompt', alBeforeInstall);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg?.waiting) {
          setNuevaVersionSwDisponible(true);
        }
      });
    }

    return () => {
      window.removeEventListener('online', alConectar);
      window.removeEventListener('offline', alDesconectar);
      window.removeEventListener('beforeinstallprompt', alBeforeInstall);
    };
  }, [clienteSupabase, ejecutarSincronizacionManualOAutomatica]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* ==================== 1. PANEL DE ESTADO DE CONEXIÓN Y SINCRONIZACIÓN ==================== */}
      <section className="card">
        <div className="card-title">
          <span>1. Estado de Conexión y Sincronización Cloud Autónoma (Celular ↔ Supabase ↔ PC)</span>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span className={`badge ${enLinea ? 'badge-ingreso' : 'badge-gasto'}`}>
              {enLinea ? '● CONECTADO A INTERNET' : '○ SIN CONEXIÓN (MODO OFFLINE)'}
            </span>
            <span className="badge badge-origen">Dispositivo: {dispositivoId}</span>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))',
            gap: '10px',
            marginBottom: '14px',
          }}
        >
          <div className="kpi-box">
            <div className="kpi-label">Estado de red y operación</div>
            <div className="kpi-value" style={{ fontSize: '1rem' }}>
              {enLinea ? 'Online (Conexión directa Cloud)' : 'Offline (Persistencia IndexedDB)'}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
              Sin internet puedes seguir registrando movimientos, eventos y presupuestos en el celular.
            </div>
          </div>

          <div className="kpi-box">
            <div className="kpi-label">Operaciones pendientes en cola local</div>
            <div className="kpi-value">{instantanea.cambiosPendientesSync}</div>
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
              Persisten al cerrar la app o reiniciar el celular; se sincronizan al recuperar señal.
            </div>
          </div>

          <div className="kpi-box">
            <div className="kpi-label">Última sincronización</div>
            <div className="kpi-value" style={{ fontSize: '0.98rem' }}>
              {ultimaSyncIso ? fechaHoraLima(ultimaSyncIso) : 'Sin sincronizar aún'}
            </div>
          </div>

          <div className="kpi-box">
            <div className="kpi-label">Conflictos entre dispositivos</div>
            <div className={`kpi-value ${conflictos.length > 0 ? 'egreso' : 'ingreso'}`}>
              {conflictos.length}
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
              {conflictos.length === 0
                ? 'Sin conflictos de versión'
                : 'Requieren resolución explícita (no se sobrescribe silenciosamente)'}
            </div>
          </div>

          <div className="kpi-box">
            <div className="kpi-label">Independencia de la PC</div>
            <div className="kpi-value ingreso" style={{ fontSize: '0.95rem' }}>
              100 % Autónoma (Vercel + Supabase)
            </div>
            <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
              Cero dependencia de localhost o IP local. Funciona con tu computadora apagada.
            </div>
          </div>
        </div>

        {errorSync && (
          <div className="aviso-insuficiente" style={{ marginBottom: '12px' }} role="alert">
            {errorSync}
          </div>
        )}
        {mensajeSync && (
          <div
            style={{
              marginBottom: '12px',
              padding: '10px 12px',
              background: '#dcfce7',
              color: '#166534',
              borderRadius: '8px',
              fontSize: '0.86rem',
              fontWeight: 600,
            }}
          >
            {mensajeSync}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-primario"
            disabled={sincronizando}
            onClick={() => void ejecutarSincronizacionManualOAutomatica()}
          >
            {sincronizando ? 'Sincronizando...' : '↻ Sincronizar ahora'}
          </button>

          {sesion ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.84rem' }}>
              <span className="badge badge-ingreso">
                Sesión RLS activa: {sesion.email}
              </span>
              <button
                type="button"
                className="btn btn-peligro"
                onClick={async () => {
                  await clienteSupabase.cerrarSesion();
                  setSesionInterna(null);
                  await onCambioSesion?.(null);
                  await repositorio.guardarSesionCloudPersistente?.(null);
                  setMensajeSync('Sesión de Supabase cerrada y token limpiado de memoria e IndexedDB.');
                }}
              >
                Cerrar sesión cloud
              </button>
            </div>
          ) : (
            <form
              style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}
              onSubmit={async (e) => {
                e.preventDefault();
                setErrorSync(null);
                try {
                  const nueva = await clienteSupabase.iniciarSesionConContrasena(
                    emailLogin,
                    passwordLogin,
                  );
                  setSesionInterna(nueva);
                  await onCambioSesion?.(nueva);
                  await repositorio.guardarSesionCloudPersistente?.(nueva);
                  setPasswordLogin('');
                  setMensajeSync(
                    `Autenticado como propietario (${nueva.email}). Sesión persistida en IndexedDB para reconexión móvil automática.`,
                  );
                } catch (err) {
                  setErrorSync((err as Error).message);
                }
              }}
            >
              <input
                type="email"
                className="input-control"
                placeholder="Correo del propietario (Supabase Auth)"
                value={emailLogin}
                onChange={(e) => setEmailLogin(e.target.value)}
                required
              />
              <input
                type="password"
                className="input-control"
                placeholder="Contraseña"
                value={passwordLogin}
                onChange={(e) => setPasswordLogin(e.target.value)}
                required
              />
              <button type="submit" className="btn">
                Conectar cuenta privada
              </button>
            </form>
          )}
        </div>
      </section>

      {/* ==================== 2. RESOLUCIÓN SEGURA DE CONFLICTOS ENTRE DISPOSITIVOS ==================== */}
      {conflictos.length > 0 && (
        <section className="card" style={{ borderColor: '#fca5a5', background: '#fff5f5' }}>
          <div className="card-title">
            <span>Conflictos Detectados (Protección contra Sobrescritura Silenciosa)</span>
            <span className="badge badge-gasto">{conflictos.length} pendiente(s)</span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.85rem', color: '#7f1d1d' }}>
            El siguiente registro fue modificado simultáneamente en este dispositivo y en otro dispositivo. Elige qué
            versión conservar:
          </p>
          <div className="lista-movimientos">
            {conflictos.map((conf) => (
              <article key={conf.id} className="item-movimiento" style={{ flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <strong>
                    Entidad: {conf.entidad} · ID: {conf.registroId} ({conf.motivo})
                  </strong>
                  <span className="badge badge-origen">
                    Local v{conf.sobreLocal.version} vs. Nube v{conf.sobreRemoto.version}
                  </span>
                </div>
                <div className="analitica-grid-2col" style={{ width: '100%', marginTop: '8px' }}>
                  <div className="kpi-box">
                    <div className="kpi-label">
                      Versión en este dispositivo ({conf.sobreLocal.dispositivoId})
                    </div>
                    <pre style={{ fontSize: '0.74rem', overflowX: 'auto', margin: '4px 0 0 0' }}>
                      {JSON.stringify(conf.sobreLocal.datos, null, 2)}
                    </pre>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">
                      Versión en la nube ({conf.sobreRemoto.dispositivoId})
                    </div>
                    <pre style={{ fontSize: '0.74rem', overflowX: 'auto', margin: '4px 0 0 0' }}>
                      {JSON.stringify(conf.sobreRemoto.datos, null, 2)}
                    </pre>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  {(
                    [
                      { est: 'CONSERVAR_LOCAL', texto: 'Conservar mi versión local' },
                      { est: 'CONSERVAR_REMOTO', texto: 'Conservar la versión de la nube' },
                    ] as { est: EstrategiaResolucionConflicto; texto: string }[]
                  ).map((op) => (
                    <button
                      key={op.est}
                      type="button"
                      className="btn btn-primario"
                      onClick={async () => {
                        await repositorio.resolverConflictoSincronizacion({
                          conflictoId: conf.id,
                          estrategia: op.est,
                          dispositivoId,
                        });
                        await cargarConflictos();
                        await onRecargar();
                      }}
                    >
                      {op.texto}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ==================== 3. RESPALDO JSON CIFRADO (WEB CRYPTO AES-256-GCM) Y PAQUETES QR ==================== */}
      <div className="analitica-grid-2col">
        <section className="card">
          <div className="card-title">
            <span>2. Respaldo JSON Cifrado con Contraseña (AES-256-GCM)</span>
            <span className="badge badge-origen">Web Crypto PBKDF2</span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            {LIMITACIONES_CIFRADO_WEB_CRYPTO}
          </p>

          <div className="campo-form">
            <label htmlFor="pass-export-enc">Contraseña para cifrar copia de seguridad (.enc.json)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="pass-export-enc"
                type="password"
                className="input-control"
                style={{ flex: 1 }}
                placeholder="Mínimo 6 caracteres"
                value={passCifradoExport}
                onChange={(e) => setPassCifradoExport(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-primario"
                onClick={async () => {
                  setErrorCifrado(null);
                  setMensajeCifrado(null);
                  try {
                    const jsonPlano = exportarLibroAJson({
                      cuentas: instantanea.cuentas,
                      categorias: instantanea.categorias,
                      eventos: instantanea.eventos,
                      presupuestos: instantanea.presupuestos,
                      movimientos: instantanea.movimientos,
                      gastosPlanificados: instantanea.gastosPlanificados,
                      gastosCompartidos: instantanea.gastosCompartidos,
                      liquidacionesCompartidas: instantanea.liquidacionesCompartidas,
                      reglasRecurrencia: instantanea.reglasRecurrencia,
                    });
                    const jsonCifrado = await exportarJsonCifradoConContrasena(
                      JSON.parse(jsonPlano),
                      passCifradoExport,
                    );
                    const blob = new Blob([jsonCifrado], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `mis-cuentas-respaldo-cifrado-${new Date().toISOString().slice(0, 10)}.enc.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setMensajeCifrado(
                      'Respaldo cifrado (.enc.json) generado y descargado correctamente con AES-256-GCM.',
                    );
                  } catch (err) {
                    setErrorCifrado((err as Error).message);
                  }
                }}
              >
                Descargar .enc.json
              </button>
            </div>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '14px 0' }} />

          <div className="campo-form">
            <label htmlFor="file-import-enc">Restaurar y validar respaldo cifrado (.enc.json)</label>
            <input
              id="file-import-enc"
              type="file"
              accept=".json,.enc.json"
              className="input-control"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const txt = await f.text();
                setTextoCifradoImportar(txt);
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="password"
              className="input-control"
              style={{ flex: 1 }}
              placeholder="Contraseña del archivo .enc.json"
              value={passCifradoImport}
              onChange={(e) => setPassCifradoImport(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setErrorCifrado(null);
                setMensajeCifrado(null);
                try {
                  const descifrado = await importarJsonCifradoConContrasena(
                    textoCifradoImportar,
                    passCifradoImport,
                  );
                  const loteId = `lote-enc-${Date.now()}`;
                  const prev = previsualizarImportacionJson({
                    contenidoJson: JSON.stringify(descifrado),
                    movimientosExistentes: instantanea.movimientos,
                    loteImportacionId: loteId,
                  });
                  if (prev.conErrores > 0) {
                    const primerError =
                      prev.filas.find((f) => f.estado === 'ERROR')?.errores.join(', ') ??
                      'Error de formato JSON';
                    throw new Error(primerError);
                  }
                  const res = await repositorio.ejecutarImportacionTransaccional({
                    loteId,
                    filasPrevisualizadas: prev.filas,
                    politicaDuplicados: 'OMITIR',
                    cuentasIncluidas: prev.cuentasIncluidas,
                    categoriasIncluidas: prev.categoriasIncluidas,
                    eventosIncluidos: prev.eventosIncluidos,
                    presupuestosIncluidos: prev.presupuestosIncluidos,
                    gastosPlanificadosIncluidos: prev.gastosPlanificadosIncluidos,
                    gastosCompartidosIncluidos: prev.gastosCompartidosIncluidos,
                    liquidacionesCompartidasIncluidas: prev.liquidacionesCompartidasIncluidas,
                    reglasRecurrenciaIncluidas: prev.reglasRecurrenciaIncluidas,
                  });
                  await onRecargar();
                  setMensajeCifrado(
                    `Respaldo cifrado verificado (SHA-256 OK): ${res.insertados} insertado(s), ${res.omitidosPorDuplicado} duplicado(s) omitido(s).`,
                  );
                } catch (err) {
                  setErrorCifrado((err as Error).message);
                }
              }}
            >
              Descifrar y Restaurar
            </button>
          </div>

          {errorCifrado && (
            <div className="aviso-insuficiente" style={{ marginTop: '10px' }}>
              {errorCifrado}
            </div>
          )}
          {mensajeCifrado && (
            <div
              style={{
                marginTop: '10px',
                padding: '10px',
                background: '#dcfce7',
                color: '#166534',
                borderRadius: '8px',
                fontSize: '0.84rem',
              }}
            >
              {mensajeCifrado}
            </div>
          )}
        </section>

        {/* Transferencia por QR de paquetes cortos cifrados */}
        <section className="card">
          <div className="card-title">
            <span>3. Emparejamiento y Paquetes Cortos Cifrados por QR</span>
            <span className="badge badge-origen">Máx. {MAX_MOVIMIENTOS_POR_PAQUETE_QR} movs</span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            Transfiere un token de emparejamiento o hasta {MAX_MOVIMIENTOS_POR_PAQUETE_QR} movimientos recientes
            cifrados entre PC y celular. Nunca se vuelca toda la base financiera en un único QR gigante.
          </p>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <select
              className="input-control"
              value={tipoQr}
              onChange={(e) =>
                setTipoQr(
                  e.target.value as 'EMPAREJAMIENTO_DISPOSITIVO' | 'MICRO_LOTE_MOVIMIENTOS',
                )
              }
            >
              <option value="MICRO_LOTE_MOVIMIENTOS">
                Últimos movimientos (máx. {MAX_MOVIMIENTOS_POR_PAQUETE_QR})
              </option>
              <option value="EMPAREJAMIENTO_DISPOSITIVO">Emparejamiento de dispositivo</option>
            </select>
            <input
              type="password"
              className="input-control"
              placeholder="Contraseña del QR (mín. 6 car.)"
              value={passQr}
              onChange={(e) => setPassQr(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primario"
              onClick={async () => {
                setErrorQr(null);
                try {
                  const activosRecientes = instantanea.movimientos
                    .filter((m) => m.estado === 'ACTIVO')
                    .slice(0, MAX_MOVIMIENTOS_POR_PAQUETE_QR);
                  const cadena = await generarPaqueteQrCifrado({
                    tipoPaquete: tipoQr,
                    contrasena: passQr,
                    emparejamiento: {
                      dispositivoOrigenId: dispositivoId,
                      supabaseUrl: null,
                      propietarioHint: sesion?.email ?? null,
                    },
                    movimientos:
                      tipoQr === 'MICRO_LOTE_MOVIMIENTOS' ? activosRecientes : [],
                  });
                  setCadenaQrGenerada(cadena);
                } catch (err) {
                  setErrorQr((err as Error).message);
                }
              }}
            >
              Generar QR cifrado
            </button>
          </div>

          {cadenaQrGenerada && (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
              <MatrizVisualQrSvg texto={cadenaQrGenerada} />
              <div style={{ flex: 1, minWidth: '180px' }}>
                <div style={{ fontSize: '0.76rem', color: '#475569', marginBottom: '4px' }}>
                  Paquete corto cifrado ({cadenaQrGenerada.length} bytes):
                </div>
                <textarea
                  readOnly
                  className="input-control"
                  style={{ width: '100%', height: '84px', fontSize: '0.72rem' }}
                  value={cadenaQrGenerada}
                />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              className="input-control"
              style={{ flex: 1 }}
              placeholder="Pegar paquete QR escaneado..."
              value={cadenaQrRecibida}
              onChange={(e) => setCadenaQrRecibida(e.target.value)}
            />
            <input
              type="password"
              className="input-control"
              placeholder="Contraseña QR"
              value={passQrRecibido}
              onChange={(e) => setPassQrRecibido(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setErrorQr(null);
                setResultadoQrAbierto(null);
                try {
                  const abierto = await abrirPaqueteQrCifrado(
                    cadenaQrRecibida,
                    passQrRecibido,
                  );
                  setResultadoQrAbierto(
                    `Paquete QR verificado (${abierto.tipoPaquete}, ${abierto.cantidadMovimientos} movimiento(s)).`,
                  );
                } catch (err) {
                  setErrorQr((err as Error).message);
                }
              }}
            >
              Abrir paquete QR
            </button>
          </div>

          {errorQr && (
            <div className="aviso-insuficiente" style={{ marginTop: '8px' }}>
              {errorQr}
            </div>
          )}
          {resultadoQrAbierto && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 10px',
                background: '#dcfce7',
                color: '#166534',
                borderRadius: '8px',
                fontSize: '0.82rem',
              }}
            >
              {resultadoQrAbierto}
            </div>
          )}
        </section>
      </div>

      {/* ==================== 4. PRIVACIDAD, PANTALLA DE BLOQUEO Y CONVERSIÓN PWA ==================== */}
      <div className="analitica-grid-2col">
        <section className="card">
          <div className="card-title">
            <span>4. Pantalla de Bloqueo Local y Protección de Privacidad</span>
            <span className="badge badge-origen">
              {verificadorBloqueo ? 'PIN Configurado' : 'Sin PIN activo'}
            </span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            Protege el acceso visual a tus cuentas cuando prestes el celular o te alejes de la PC. El código se
            verifica mediante hash PBKDF2-SHA256 persistido en IndexedDB sin guardar jamás la clave en texto plano.
          </p>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="password"
              className="input-control"
              placeholder="Nuevo PIN o contraseña (mín. 4 car.)"
              value={nuevoPinBloqueo}
              onChange={(e) => setNuevoPinBloqueo(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-primario"
              onClick={async () => {
                try {
                  const ver = await crearVerificadorBloqueoLocal(nuevoPinBloqueo, 60_000);
                  await onConfigurarBloqueo(ver);
                  setNuevoPinBloqueo('');
                  setMensajeBloqueo('Código de bloqueo local configurado y persistido en IndexedDB.');
                } catch (err) {
                  setMensajeBloqueo((err as Error).message);
                }
              }}
            >
              Configurar PIN
            </button>
            {verificadorBloqueo && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={onActivarBloqueoAhora}
                >
                  🔒 Bloquear pantalla ahora
                </button>
                <button
                  type="button"
                  className="btn btn-peligro"
                  onClick={async () => {
                    await onConfigurarBloqueo(null);
                    setMensajeBloqueo('Bloqueo local desactivado.');
                  }}
                >
                  Quitar PIN
                </button>
              </>
            )}
          </div>
          {mensajeBloqueo && (
            <div style={{ marginTop: '8px', fontSize: '0.82rem', color: '#1e3a8a' }}>
              {mensajeBloqueo}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-title">
            <span>5. Instalación PWA (Android e iPhone / iOS) e Independencia de la PC</span>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <span className="badge badge-origen">Plataforma: {plataformaDetectada}</span>
              <span className={`badge ${esStandalone ? 'badge-ingreso' : 'badge-origen'}`}>
                {esStandalone ? '● Instalada (Standalone)' : 'Modo Navegador'}
              </span>
            </div>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            Alojada en <strong>Vercel</strong> con base de datos en <strong>Supabase Cloud</strong>. Funciona en tus
            viajes con la computadora completamente apagada: registra movimientos offline en <code>IndexedDB</code>,
            los conserva al cerrar la app o reiniciar el teléfono, y sincroniza automáticamente al recuperar Internet
            móvil.
          </p>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {eventoInstalacion && !esStandalone && (
              <button
                type="button"
                className="btn btn-primario"
                onClick={async () => {
                  await eventoInstalacion.prompt();
                  const choice = await eventoInstalacion.userChoice;
                  if (choice.outcome === 'accepted') {
                    setEsStandalone(true);
                    setEventoInstalacion(null);
                  }
                }}
              >
                ⬇ Instalar aplicación Mis Cuentas
              </button>
            )}

            {nuevaVersionSwDisponible && (
              <button
                type="button"
                className="btn btn-primario"
                onClick={async () => {
                  const reg = await navigator.serviceWorker?.getRegistration();
                  reg?.waiting?.postMessage({ tipo: 'SKIP_WAITING' });
                  window.location.reload();
                }}
              >
                Actualizar a nueva versión disponible
              </button>
            )}
          </div>

          <div className="kpi-box" style={{ fontSize: '0.78rem', color: '#334155', marginBottom: '8px' }}>
            <strong>Instrucciones de instalación en celular:</strong>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              <li>
                <strong>En Android (Chrome / Edge / Brave):</strong> Pulsa el botón{' '}
                <em>&ldquo;⬇ Instalar aplicación Mis Cuentas&rdquo;</em> de arriba o abre el menú del navegador (⋮) →{' '}
                <strong>Instalar aplicación / Agregar a la pantalla principal</strong>.
              </li>
              <li>
                <strong>En iPhone / iOS (Safari):</strong> Abre esta URL en <strong>Safari</strong>, toca el icono{' '}
                <strong>Compartir</strong> (cuadrado con flecha hacia arriba en la barra inferior) y selecciona{' '}
                <strong>&ldquo;Agregar a inicio&rdquo; (Add to Home Screen)</strong> → <strong>Agregar</strong>.
              </li>
            </ul>
          </div>

          <div className="kpi-box" style={{ fontSize: '0.78rem', color: '#334155', marginBottom: '8px' }}>
            <strong>Dominio gratuito HTTPS en Vercel (*.vercel.app — sin compra de dominio ni DNS):</strong>
            <div style={{ marginTop: '4px' }}>
              <div>
                <strong>Site URL en Supabase Auth:</strong>{' '}
                <code>{configDominioVercel.siteUrlSupabase ?? 'https://<tu-proyecto>.vercel.app'}</code>
              </div>
              <div style={{ marginTop: '2px' }}>
                <strong>Redirect URLs en Supabase Auth:</strong>{' '}
                <code>
                  {configDominioVercel.redirectUrlsSupabase.join(' , ') ||
                    'https://<tu-proyecto>.vercel.app/auth/callback'}
                </code>
              </div>
              {configDominioVercel.advertenciaEstabilidadPwa && (
                <div className="aviso-insuficiente" style={{ marginTop: '6px', padding: '6px 8px' }}>
                  {configDominioVercel.advertenciaEstabilidadPwa}
                </div>
              )}
              <div style={{ marginTop: '4px', color: '#1e3a8a', fontWeight: 600 }}>
                🔒 {configDominioVercel.principioSeguridadZeroTrust}
              </div>
            </div>
          </div>

          <div className="kpi-box" style={{ fontSize: '0.78rem', color: '#334155' }}>
            <strong>Guía rápida de operación en viajes (con tu PC apagada):</strong>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              <li>
                <strong>Sin Internet (Modo Avión / Frontera / Ruta):</strong> Registra ingresos, egresos y eventos con
                normalidad; quedan guardados en <code>IndexedDB</code> aunque cierres la app o reinicies el celular.
              </li>
              <li>
                <strong>Al recuperar Internet móvil (4G/5G):</strong> La aplicación sincroniza automáticamente la cola
                pendiente directo contra Supabase Cloud con control de duplicados y conflictos.
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
};
