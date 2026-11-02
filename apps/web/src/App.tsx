import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  calcularResumenPeriodo,
  fechaHoraLima,
  formatearMonto,
  hoyLima,
  mesDe,
  type MovimientoFinanciero,
} from '@mis-cuentas/core';
import { FormularioMovimientoRapido } from './componentes/FormularioMovimientoRapido';
import { PanelAnaliticaAvanzada } from './componentes/PanelAnaliticaAvanzada';
import { PanelCalendarioYRecurrentes } from './componentes/PanelCalendarioYRecurrentes';
import { PanelConfiguracionCatalogos } from './componentes/PanelConfiguracionCatalogos';
import { PanelEventosUniversal } from './componentes/PanelEventosUniversal';
import { PanelImportarExportar } from './componentes/PanelImportarExportar';
import { PanelPrediccionesYRiesgo } from './componentes/PanelPrediccionesYRiesgo';
import { PanelSincronizacionYPwa } from './componentes/PanelSincronizacionYPwa';
import { PantallaBloqueoApp } from './componentes/PantallaBloqueoApp';
import {
  ClienteSupabasePrivado,
  type SesionPropietarioSupabase,
} from './persistencia/cliente_supabase';
import { RepositorioIndexedDB } from './persistencia/indexeddb';
import {
  AdaptadorSupabaseDesacoplado,
  type EstadoInstantaneoRepositorio,
  type RegistroAuditoriaLocal,
  type RepositorioFinanciero,
} from './persistencia/puerto';

type VistaActiva =
  | 'dashboard'
  | 'analitica'
  | 'predicciones'
  | 'eventos'
  | 'calendario'
  | 'movimientos'
  | 'catalogos'
  | 'intercambio'
  | 'sincronizacion'
  | 'auditoria';

function formatearPorcentajeBp(bp: number): string {
  const signo = bp > 0 ? '+' : '';
  return `${signo}${(bp / 100).toFixed(2)}%`;
}

const MAPA_RUTA_A_VISTA: Record<string, VistaActiva> = {
  '/': 'dashboard',
  '/resumen': 'dashboard',
  '/analitica': 'analitica',
  '/predicciones': 'predicciones',
  '/eventos': 'eventos',
  '/calendario': 'calendario',
  '/movimientos': 'movimientos',
  '/catalogos': 'catalogos',
  '/intercambio': 'intercambio',
  '/importar': 'intercambio',
  '/sincronizacion': 'sincronizacion',
  '/auth/callback': 'sincronizacion',
  '/auditoria': 'auditoria',
};

const MAPA_VISTA_A_RUTA: Record<VistaActiva, string> = {
  dashboard: '/',
  analitica: '/analitica',
  predicciones: '/predicciones',
  eventos: '/eventos',
  calendario: '/calendario',
  movimientos: '/movimientos',
  catalogos: '/catalogos',
  intercambio: '/intercambio',
  sincronizacion: '/sincronizacion',
  auditoria: '/auditoria',
};

export function resolverVistaDesdeUbicacion(pathname: string): VistaActiva {
  const normalizada = pathname.trim().toLowerCase().replace(/\/+$/, '') || '/';
  return MAPA_RUTA_A_VISTA[normalizada] ?? 'dashboard';
}

export const App: React.FC<{ repositorioExterno?: RepositorioFinanciero }> = ({ repositorioExterno }) => {
  const repositorio = useMemo<RepositorioFinanciero>(
    () =>
      repositorioExterno ??
      new RepositorioIndexedDB({
        puertoSync: new AdaptadorSupabaseDesacoplado(),
      }),
    [repositorioExterno],
  );

  const [cargando, setCargando] = useState<boolean>(true);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [instantanea, setInstantanea] = useState<EstadoInstantaneoRepositorio | null>(null);
  const [auditoria, setAuditoria] = useState<RegistroAuditoriaLocal[]>([]);
  const [vista, setVistaInterna] = useState<VistaActiva>(() =>
    typeof window !== 'undefined'
      ? resolverVistaDesdeUbicacion(window.location.pathname)
      : 'dashboard',
  );
  const setVista = useCallback((nuevaVista: VistaActiva) => {
    setVistaInterna(nuevaVista);
    if (typeof window !== 'undefined' && window.history?.pushState) {
      const rutaDestino = MAPA_VISTA_A_RUTA[nuevaVista] ?? '/';
      if (window.location.pathname !== rutaDestino) {
        window.history.pushState({ vista: nuevaVista }, '', rutaDestino);
      }
    }
  }, []);
  const [sidebarColapsada, setSidebarColapsada] = useState<boolean>(false);
  const [periodoMes, setPeriodoMes] = useState<string>(() => mesDe(hoyLima()));

  // Modal de registro rápido / edición
  const [modalAbierto, setModalAbierto] = useState<boolean>(false);
  const [movimientoEditar, setMovimientoEditar] = useState<MovimientoFinanciero | null>(null);

  const clienteSupabase = useMemo(() => new ClienteSupabasePrivado(), []);
  const [enLinea, setEnLinea] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [sincronizandoGlobal, setSincronizandoGlobal] = useState<boolean>(false);
  const [sesionCloud, setSesionCloud] = useState<SesionPropietarioSupabase | null>(() =>
    clienteSupabase.obtenerSesionActual(),
  );

  // Pantalla de bloqueo local de la aplicación (hash PBKDF2-SHA256 persistido en IndexedDB)
  const [verificadorBloqueo, setVerificadorBloqueo] = useState<{
    saltHex: string;
    hashHex: string;
    iteraciones: number;
  } | null>(null);
  const [bloqueado, setBloqueado] = useState<boolean>(false);

  // Filtros de movimientos (por texto, etiqueta, evento, categoría y rango de fechas)
  const [filtroTexto, setFiltroTexto] = useState<string>('');
  const [filtroEtiqueta, setFiltroEtiqueta] = useState<string>('');
  const [filtroEventoId, setFiltroEventoId] = useState<string>('');
  const [filtroCategoriaId, setFiltroCategoriaId] = useState<string>('');
  const [filtroDesde, setFiltroDesde] = useState<string>('');
  const [filtroHasta, setFiltroHasta] = useState<string>('');
  const [mostrarPapelera, setMostrarPapelera] = useState<boolean>(false);

  const recargar = useCallback(async () => {
    try {
      await repositorio.inicializar();
      const [inst, aud, estadoPersistido] = await Promise.all([
        repositorio.obtenerInstantanea(),
        repositorio.listarAuditoria(80),
        repositorio.obtenerEstadoPersistenciaDispositivo
          ? repositorio.obtenerEstadoPersistenciaDispositivo()
          : Promise.resolve(null),
      ]);
      setInstantanea(inst);
      setAuditoria(aud);
      if (estadoPersistido) {
        if (estadoPersistido.verificadorBloqueo) {
          setVerificadorBloqueo(estadoPersistido.verificadorBloqueo);
        }
        if (estadoPersistido.sesionCloud && !clienteSupabase.obtenerSesionActual()) {
          clienteSupabase.restaurarSesion(estadoPersistido.sesionCloud);
          setSesionCloud(estadoPersistido.sesionCloud);
        }
      }
      setErrorCarga(null);
    } catch (err) {
      setErrorCarga((err as Error).message);
    } finally {
      setCargando(false);
    }
  }, [repositorio, clienteSupabase]);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  // Soporte de navegación SPA al actualizar la página, usar atrás/adelante en Android/iOS,
  // atajos de icono PWA (?accion=nuevo) y redirecciones de autenticación de Supabase (#access_token=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const manejarPopState = () => {
      setVistaInterna(resolverVistaDesdeUbicacion(window.location.pathname));
    };
    window.addEventListener('popstate', manejarPopState);

    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('accion') === 'nuevo') {
      setMovimientoEditar(null);
      setModalAbierto(true);
      if (window.history?.replaceState) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    if (window.location.hash && window.location.hash.includes('access_token=')) {
      const hrefActual = window.location.href;
      void (async () => {
        try {
          const sesionRetorno = await clienteSupabase.procesarRetornoRedireccionAuth(hrefActual);
          if (sesionRetorno) {
            setSesionCloud(sesionRetorno);
            await repositorio.guardarSesionCloudPersistente?.(sesionRetorno);
            setVistaInterna('sincronizacion');
          }
        } catch {
          // Si el token de retorno es inválido o no autorizado, no se inicia sesión
        } finally {
          if (window.history?.replaceState) {
            window.history.replaceState({}, '', window.location.pathname);
          }
        }
      })();
    }

    return () => {
      window.removeEventListener('popstate', manejarPopState);
    };
  }, [clienteSupabase, repositorio]);

  // Sincronización Cloud automática e independiente de la PC al recuperar Internet móvil o registrar cambios
  const ejecutarAutoSyncEnSegundoPlano = useCallback(async () => {
    if (!enLinea || sincronizandoGlobal || !clienteSupabase.estaConfigurado()) return;
    const sesionActiva = clienteSupabase.obtenerSesionActual();
    if (!sesionActiva) return;

    setSincronizandoGlobal(true);
    try {
      const dispId = instantanea?.dispositivoId ?? 'celular-pwa';
      await repositorio.sincronizarConTransporte({
        transporte: clienteSupabase,
        propietarioId: sesionActiva.uid,
        dispositivoId: dispId,
      });
      const sesionRenovada = clienteSupabase.obtenerSesionActual();
      if (sesionRenovada && repositorio.guardarSesionCloudPersistente) {
        await repositorio.guardarSesionCloudPersistente(sesionRenovada);
      }
      const [inst, aud] = await Promise.all([
        repositorio.obtenerInstantanea(),
        repositorio.listarAuditoria(80),
      ]);
      setInstantanea(inst);
      setAuditoria(aud);
    } catch {
      // Si la señal móvil cae en medio del intento, los movimientos permanecen seguros en la cola de IndexedDB
    } finally {
      setSincronizandoGlobal(false);
    }
  }, [enLinea, sincronizandoGlobal, clienteSupabase, instantanea?.dispositivoId, repositorio]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const alConectar = () => {
      setEnLinea(true);
      void ejecutarAutoSyncEnSegundoPlano();
    };
    const alDesconectar = () => {
      setEnLinea(false);
    };
    const alCambiarVisibilidad = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && navigator.onLine) {
        setEnLinea(true);
        void ejecutarAutoSyncEnSegundoPlano();
      }
    };
    window.addEventListener('online', alConectar);
    window.addEventListener('offline', alDesconectar);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', alCambiarVisibilidad);
    }
    return () => {
      window.removeEventListener('online', alConectar);
      window.removeEventListener('offline', alDesconectar);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', alCambiarVisibilidad);
      }
    };
  }, [ejecutarAutoSyncEnSegundoPlano]);

  useEffect(() => {
    if (enLinea && sesionCloud && (instantanea?.cambiosPendientesSync ?? 0) > 0) {
      void ejecutarAutoSyncEnSegundoPlano();
    }
  }, [enLinea, sesionCloud, instantanea?.cambiosPendientesSync, ejecutarAutoSyncEnSegundoPlano]);

  const resumen = useMemo(() => {
    if (!instantanea) return null;
    return calcularResumenPeriodo({
      periodoMes,
      cuentas: instantanea.cuentas,
      categorias: instantanea.categorias,
      movimientos: instantanea.movimientos,
      presupuestos: instantanea.presupuestos,
      limiteUltimas: 25,
    });
  }, [instantanea, periodoMes]);

  const cuentasActivas = useMemo(
    () => instantanea?.cuentas.filter((c) => c.estado === 'ACTIVO') ?? [],
    [instantanea],
  );
  const categoriasActivas = useMemo(
    () => instantanea?.categorias.filter((c) => c.estado === 'ACTIVO') ?? [],
    [instantanea],
  );
  const eventosActivosParaFormulario = useMemo(
    () =>
      (instantanea?.eventos.filter((e) => e.estado === 'ACTIVO') ?? []).map((e) => ({
        ...e,
        presupuestoCentimos: e.presupuestoTotalCentimos,
        estadoEvento: e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
      })),
    [instantanea],
  );

  const mapaCuentas = useMemo(
    () => new Map(instantanea?.cuentas.map((c) => [c.id, c.nombre]) ?? []),
    [instantanea],
  );
  const mapaCategorias = useMemo(
    () => new Map(instantanea?.categorias.map((c) => [c.id, c.nombre]) ?? []),
    [instantanea],
  );
  const mapaEventos = useMemo(
    () => new Map(instantanea?.eventos.map((e) => [e.id, e.nombre]) ?? []),
    [instantanea],
  );

  const etiquetasConocidas = useMemo(() => {
    const s = new Set<string>();
    for (const m of instantanea?.movimientos ?? []) {
      if (m.estado === 'ACTIVO') {
        for (const t of m.etiquetas) s.add(t);
      }
    }
    return [...s];
  }, [instantanea]);

  const movimientosFiltrados = useMemo(() => {
    if (!instantanea) return [];
    return instantanea.movimientos
      .filter((m) => (mostrarPapelera ? m.estado === 'ELIMINADO' : m.estado === 'ACTIVO'))
      .filter((m) => {
        if (filtroEventoId && m.eventoId !== filtroEventoId) return false;
        if (filtroCategoriaId && m.categoriaId !== filtroCategoriaId) return false;
        if (filtroDesde && m.fechaMovimiento < filtroDesde) return false;
        if (filtroHasta && m.fechaMovimiento > filtroHasta) return false;
        if (filtroEtiqueta && !m.etiquetas.some((t) => t.toLowerCase() === filtroEtiqueta.toLowerCase())) {
          return false;
        }
        if (filtroTexto.trim()) {
          const q = filtroTexto.trim().toLowerCase();
          const desc = (m.descripcion ?? '').toLowerCase();
          const cta = (mapaCuentas.get(m.cuentaId) ?? '').toLowerCase();
          const cat = (m.categoriaId ? (mapaCategorias.get(m.categoriaId) ?? '') : '').toLowerCase();
          const tags = m.etiquetas.join(' ').toLowerCase();
          return desc.includes(q) || cta.includes(q) || cat.includes(q) || tags.includes(q);
        }
        return true;
      })
      .sort((a, b) => {
        const fa = `${a.fechaMovimiento}T${a.horaMovimiento}`;
        const fb = `${b.fechaMovimiento}T${b.horaMovimiento}`;
        if (fa !== fb) return fa < fb ? 1 : -1;
        return a.registradoEn < b.registradoEn ? 1 : -1;
      });
  }, [
    instantanea,
    mostrarPapelera,
    filtroEventoId,
    filtroCategoriaId,
    filtroDesde,
    filtroHasta,
    filtroEtiqueta,
    filtroTexto,
    mapaCuentas,
    mapaCategorias,
  ]);

  if (cargando) {
    return (
      <main style={{ padding: '32px', textAlign: 'center' }} aria-busy="true">
        Cargando base de datos financiera local (IndexedDB)...
      </main>
    );
  }

  if (errorCarga || !instantanea || !resumen) {
    return (
      <main style={{ padding: '32px' }}>
        <div className="aviso-insuficiente" role="alert">
          Error al inicializar el almacenamiento: {errorCarga ?? 'Desconocido'}
        </div>
      </main>
    );
  }

  if (bloqueado && verificadorBloqueo) {
    return (
      <PantallaBloqueoApp
        verificador={verificadorBloqueo}
        onDesbloquear={() => setBloqueado(false)}
      />
    );
  }

  const renderItemMovimiento = (m: MovimientoFinanciero) => {
    const esIngreso = m.tipo === 'INGRESO';
    const esGasto = m.tipo === 'GASTO';
    const badgeClase = esIngreso
      ? 'badge-ingreso'
      : esGasto
        ? 'badge-gasto'
        : 'badge-transferencia';
    const signo = esIngreso ? '+' : esGasto ? '-' : '⇄ ';

    return (
      <article key={m.id} className="item-movimiento">
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
            <span className={`badge ${badgeClase}`}>
              {m.esPagoTarjeta ? 'PAGO TARJETA CRÉDITO' : m.tipo}
            </span>
            <span className="badge badge-origen" title="Origen trazable del registro">
              {m.auditoria.origen}
            </span>
            <strong>
              {m.tipo === 'TRANSFERENCIA'
                ? `${mapaCuentas.get(m.cuentaId) ?? 'Origen'} → ${mapaCuentas.get(m.cuentaDestinoId ?? '') ?? 'Destino'}`
                : m.tipo === 'SALDO_INICIAL'
                  ? `Saldo inicial (${mapaCuentas.get(m.cuentaId) ?? 'Cuenta'})`
                  : `${mapaCategorias.get(m.categoriaId ?? '') ?? 'Categoría'}${
                      m.subcategoriaId ? ` / ${mapaCategorias.get(m.subcategoriaId) ?? ''}` : ''
                    } · ${mapaCuentas.get(m.cuentaId) ?? 'Cuenta'}`}
            </strong>
          </div>

          {m.descripcion && (
            <div style={{ marginTop: '4px', fontSize: '0.9rem', color: '#1e293b' }}>{m.descripcion}</div>
          )}

          <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', fontSize: '0.76rem', color: '#64748b' }}>
            <span>
              Movimiento: <strong>{m.fechaMovimiento} {m.horaMovimiento}</strong>
            </span>
            <span>· Registrado: {fechaHoraLima(m.registradoEn)}</span>
            {m.eventoId && (
              <span className="badge badge-origen">
                Evento: {mapaEventos.get(m.eventoId) ?? m.eventoId}
              </span>
            )}
            {m.etiquetas.map((t) => (
              <span key={t} className="badge badge-tag">
                {t}
              </span>
            ))}
          </div>
        </div>

        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: '1.05rem',
              color: esIngreso ? '#15803d' : esGasto ? '#b91c1c' : '#0369a1',
            }}
          >
            {signo}
            {formatearMonto(m.montoCentimos, 'PEN')}
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {m.estado === 'ACTIVO' ? (
              <>
                <button
                  type="button"
                  className="btn"
                  style={{ minHeight: '32px', padding: '4px 8px', fontSize: '0.76rem' }}
                  onClick={() => {
                    setMovimientoEditar(m);
                    setModalAbierto(true);
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn btn-peligro"
                  style={{ minHeight: '32px', padding: '4px 8px', fontSize: '0.76rem' }}
                  onClick={async () => {
                    await repositorio.eliminarMovimientoLogicamente(m.id);
                    await recargar();
                  }}
                >
                  Eliminar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-primario"
                style={{ minHeight: '32px', padding: '4px 10px', fontSize: '0.76rem' }}
                onClick={async () => {
                  await repositorio.restaurarMovimiento(m.id);
                  await recargar();
                }}
              >
                Restaurar
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="app-shell">
      {/* ==================== SIDEBAR FIJA Y ADAPTABLE (PC >= 1024px) ==================== */}
      <aside className={`pc-sidebar ${sidebarColapsada ? 'colapsada' : ''}`} aria-label="Navegación lateral principal">
        <div className="pc-sidebar-brand">
          {!sidebarColapsada && <h1>Mis Cuentas (S/)</h1>}
          <button
            type="button"
            className="btn"
            style={{ minHeight: '36px', padding: '6px 10px', background: '#1e293b', color: '#fff', borderColor: '#334155' }}
            onClick={() => setSidebarColapsada((v) => !v)}
            aria-label={sidebarColapsada ? 'Expandir barra lateral' : 'Colapsar barra lateral'}
          >
            {sidebarColapsada ? '»' : '«'}
          </button>
        </div>

        <button
          type="button"
          className="btn btn-primario"
          onClick={() => {
            setMovimientoEditar(null);
            setModalAbierto(true);
          }}
        >
          {sidebarColapsada ? '+' : '+ Registrar movimiento'}
        </button>

        <nav className="pc-nav-list">
          {(
            [
              { id: 'dashboard', icono: '▣', texto: 'Dashboard (3 col)' },
              { id: 'analitica', icono: '📊', texto: 'Analítica Avanzada' },
              { id: 'predicciones', icono: '📈', texto: 'Predicciones y Riesgo Financiero' },
              { id: 'eventos', icono: '★', texto: 'Eventos, Presupuestos y Compartidos' },
              { id: 'calendario', icono: '📅', texto: 'Calendario y Recurrentes' },
              { id: 'movimientos', icono: '⇄', texto: 'Movimientos y Papelera' },
              { id: 'catalogos', icono: '⚙', texto: 'Cuentas y Categorías' },
              { id: 'intercambio', icono: '⇅', texto: 'Importar / Exportar (CSV/JSON)' },
              { id: 'sincronizacion', icono: '☁', texto: 'Sincronización, Seguridad y PWA' },
              { id: 'auditoria', icono: '🛡', texto: 'Trazabilidad y Auditoría' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`pc-nav-btn ${vista === item.id ? 'activo' : ''}`}
              onClick={() => setVista(item.id)}
            >
              <span aria-hidden="true">{item.icono}</span>
              {!sidebarColapsada && <span>{item.texto}</span>}
            </button>
          ))}
        </nav>

        {!sidebarColapsada && (
          <div style={{ fontSize: '0.76rem', color: '#94a3b8', borderTop: '1px solid #1e293b', paddingTop: '12px' }}>
            <div>Moneda: PEN (S/) · America/Lima</div>
            <div>
              Red: {enLinea ? '● Online (Cloud)' : '○ Offline (IndexedDB)'}
              {sincronizandoGlobal ? ' · Sincronizando...' : ''}
            </div>
            <div>Cola Sync Supabase: {instantanea.cambiosPendientesSync} pendiente(s)</div>
          </div>
        )}
      </aside>

      {/* ==================== BARRA SUPERIOR MÓVIL (< 1024px) ==================== */}
      <header className="mobile-topbar">
        <div>
          <h1>Mis Cuentas · PEN (S/)</h1>
          <div style={{ fontSize: '0.72rem', color: enLinea ? '#86efac' : '#fde047' }}>
            {enLinea
              ? sincronizandoGlobal
                ? '↻ Sincronizando con Supabase Cloud...'
                : `● Online · ${instantanea.cambiosPendientesSync} pend.`
              : `○ Offline (IndexedDB) · ${instantanea.cambiosPendientesSync} pend.`}
          </div>
        </div>
        <input
          type="month"
          aria-label="Seleccionar mes del periodo"
          className="periodo-selector"
          value={periodoMes}
          onChange={(e) => setPeriodoMes(e.target.value)}
        />
      </header>

      {/* ==================== ÁREA PRINCIPAL ==================== */}
      <main className="main-area">
        <div className="pc-header">
          <div>
            <h2>
              {vista === 'dashboard' && `Dashboard Financiero (${periodoMes})`}
              {vista === 'analitica' && 'Analítica Avanzada'}
              {vista === 'predicciones' && 'Predicciones y Riesgo Financiero'}
              {vista === 'eventos' && 'Sistema Universal de Eventos, Presupuestos y Gastos Compartidos'}
              {vista === 'calendario' && 'Calendario Financiero y Compromisos Recurrentes'}
              {vista === 'movimientos' && 'Libro de Movimientos y Papelera'}
              {vista === 'catalogos' && 'Cuentas, Categorías y Presupuestos Mensuales'}
              {vista === 'intercambio' && 'Importación y Exportación Transaccional (CSV / JSON)'}
              {vista === 'sincronizacion' && 'Sincronización Multidispositivo, Seguridad y PWA'}
              {vista === 'auditoria' && 'Historial de Auditoría y Trazabilidad'}
            </h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <label htmlFor="pc-periodo-mes" style={{ fontWeight: 700, fontSize: '0.88rem' }}>
              Periodo (Lima):
            </label>
            <input
              id="pc-periodo-mes"
              type="month"
              className="input-control"
              value={periodoMes}
              onChange={(e) => setPeriodoMes(e.target.value)}
            />
          </div>
        </div>

        {/* Estado vacío inicial sin datos ficticios */}
        {instantanea.vacia && (
          <section className="card" style={{ marginBottom: '18px', borderColor: '#93c5fd', background: '#eff6ff' }}>
            <h3 className="card-title">Base de datos real iniciada en blanco (0 registros ficticios)</h3>
            <p style={{ margin: '0 0 12px 0', color: '#1e3a8a', fontSize: '0.92rem' }}>
              Siguiendo las reglas innegociables del sistema, no existen transacciones simuladas ni saldos de
              demostración. Puedes habilitar en un toque los métodos de pago (Efectivo, Yape, Plin, Tarjeta de débito,
              Tarjeta de crédito) y las categorías base —todos con saldo cero— o crearlos manualmente.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
              <button
                type="button"
                className="btn btn-primario"
                onClick={async () => {
                  await repositorio.activarMetodosInicialesSugeridos();
                  await repositorio.activarCategoriasInicialesSugeridas();
                  await recargar();
                }}
              >
                Habilitar métodos de pago y categorías base (con saldo 0)
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setVista('intercambio')}
              >
                Importar desde archivo real (.CSV / .JSON)
              </button>
            </div>
          </section>
        )}

        {/* ==================== VISTA 1: DASHBOARD (3 COLUMNAS EN PC) ==================== */}
        {vista === 'dashboard' && (
          <div className="dashboard-grid-3col">
            {/* COLUMNA 1: Resumen del periodo, comparación y saldos registrados por cuenta */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <section className="card">
                <div className="card-title">
                  <span>Resumen del periodo ({periodoMes})</span>
                  <span className="badge badge-origen">DERIVADO</span>
                </div>
                <div className="kpi-grid">
                  <div className="kpi-box">
                    <div className="kpi-label">Ingresos del periodo</div>
                    <div className="kpi-value ingreso">
                      {formatearMonto(resumen.ingresosPeriodoCentimos, 'PEN')}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Egresos del periodo</div>
                    <div className="kpi-value egreso">
                      {formatearMonto(resumen.egresosPeriodoCentimos, 'PEN')}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Flujo neto ({periodoMes})</div>
                    <div className="kpi-value">
                      {formatearMonto(resumen.flujoNetoPeriodoCentimos, 'PEN')}
                    </div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">Saldo bancario real verificado</div>
                    <div className="kpi-value">
                      {resumen.saldoRegistradoConocidoCentimos !== null
                        ? formatearMonto(resumen.saldoRegistradoConocidoCentimos, 'PEN')
                        : 'Sin saldo inicial'}
                    </div>
                  </div>
                </div>
                {resumen.transferenciasPeriodoCentimos > 0 && (
                  <div style={{ marginTop: '10px', fontSize: '0.8rem', color: '#475569' }}>
                    Transferencias internas del mes:{' '}
                    <strong>{formatearMonto(resumen.transferenciasPeriodoCentimos, 'PEN')}</strong> (no suman a
                    ingresos ni a gastos).
                  </div>
                )}
              </section>

              {/* Comparación con el periodo anterior */}
              <section className="card">
                <div className="card-title">
                  <span>Comparación vs. periodo anterior</span>
                  <span className="badge badge-origen">DERIVADO</span>
                </div>
                {resumen.comparacionPeriodoAnterior.estado === 'HISTORIAL_INSUFICIENTE' ? (
                  <div className="aviso-insuficiente">
                    {resumen.comparacionPeriodoAnterior.mensaje}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.88rem', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div>
                      Periodo previo ({resumen.comparacionPeriodoAnterior.datos.periodoAnterior}): Ingresos{' '}
                      <strong>
                        {formatearMonto(
                          resumen.comparacionPeriodoAnterior.datos.ingresosAnteriorCentimos,
                          'PEN',
                        )}
                      </strong>{' '}
                      · Egresos{' '}
                      <strong>
                        {formatearMonto(
                          resumen.comparacionPeriodoAnterior.datos.egresosAnteriorCentimos,
                          'PEN',
                        )}
                      </strong>
                    </div>
                    <div>
                      Variación de ingresos:{' '}
                      <strong>
                        {resumen.comparacionPeriodoAnterior.datos.variacionIngresosBp !== null
                          ? formatearPorcentajeBp(
                              resumen.comparacionPeriodoAnterior.datos.variacionIngresosBp,
                            )
                          : 'N/A (base 0)'}
                      </strong>
                    </div>
                    <div>
                      Variación de egresos:{' '}
                      <strong>
                        {resumen.comparacionPeriodoAnterior.datos.variacionEgresosBp !== null
                          ? formatearPorcentajeBp(
                              resumen.comparacionPeriodoAnterior.datos.variacionEgresosBp,
                            )
                          : 'N/A (base 0)'}
                      </strong>
                    </div>
                  </div>
                )}
              </section>

              {/* Saldos por cuenta / método de pago */}
              <section className="card">
                <div className="card-title">
                  <span>Saldos por cuenta / método</span>
                  <button
                    type="button"
                    className="btn"
                    style={{ minHeight: '32px', padding: '4px 10px', fontSize: '0.78rem' }}
                    onClick={() => setVista('catalogos')}
                  >
                    Configurar
                  </button>
                </div>
                {resumen.saldosPorCuenta.length === 0 ? (
                  <div className="estado-vacio">
                    No hay cuentas ni métodos de pago registrados todavía.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {resumen.saldosPorCuenta.map((s) => (
                      <div key={s.cuentaId} className="kpi-box">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong>{s.nombreCuenta}</strong>
                          <span className="badge badge-origen">{s.tipoCuenta}</span>
                        </div>
                        {s.saldoBancarioRealCentimos !== null ? (
                          <div style={{ marginTop: '4px', fontWeight: 800, fontSize: '1.05rem' }}>
                            {formatearMonto(s.saldoBancarioRealCentimos, 'PEN')}
                          </div>
                        ) : (
                          <div style={{ marginTop: '4px', fontSize: '0.8rem', color: '#b45309' }}>
                            Sin saldo inicial real · Flujo registrado:{' '}
                            <strong>{formatearMonto(s.flujoMovimientosCentimos, 'PEN')}</strong>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* COLUMNA 2: Panel principal de movimientos recientes */}
            <section className="card">
              <div className="card-title">
                <span>Movimientos recientes</span>
                <button
                  type="button"
                  className="btn btn-primario"
                  style={{ minHeight: '36px', padding: '6px 12px', fontSize: '0.84rem' }}
                  onClick={() => {
                    setMovimientoEditar(null);
                    setModalAbierto(true);
                  }}
                >
                  + Nuevo movimiento
                </button>
              </div>

              {resumen.ultimasTransacciones.length === 0 ? (
                <div className="estado-vacio">
                  Aún no hay movimientos registrados. Usa el botón <strong>+</strong> para registrar un ingreso,
                  egreso o transferencia en segundos.
                </div>
              ) : (
                <div className="lista-movimientos">
                  {resumen.ultimasTransacciones.map(renderItemMovimiento)}
                </div>
              )}
            </section>

            {/* COLUMNA 3: Distribución de gastos y Presupuestos */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <section className="card">
                <div className="card-title">
                  <span>Distribución de gastos ({periodoMes})</span>
                  <span className="badge badge-origen">DERIVADO</span>
                </div>
                {resumen.distribucionGastos.estado === 'HISTORIAL_INSUFICIENTE' ? (
                  <div className="aviso-insuficiente">
                    {resumen.distribucionGastos.mensaje}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {resumen.distribucionGastos.datos.map((item) => (
                      <div key={item.categoriaId}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem' }}>
                          <strong>{item.nombreCategoria}</strong>
                          <span>
                            {formatearMonto(item.montoCentimos, 'PEN')} (
                            {(item.porcentajeBasisPoints / 100).toFixed(1)}%)
                          </span>
                        </div>
                        <div className="barra-progreso">
                          <div
                            className="barra-progreso-fill"
                            style={{ width: `${Math.min(100, item.porcentajeBasisPoints / 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="card">
                <div className="card-title">
                  <span>Presupuestos del mes ({periodoMes})</span>
                  <button
                    type="button"
                    className="btn"
                    style={{ minHeight: '32px', padding: '4px 10px', fontSize: '0.78rem' }}
                    onClick={() => setVista('catalogos')}
                  >
                    Configurar
                  </button>
                </div>
                {resumen.estadoPresupuestos.length === 0 ? (
                  <div className="estado-vacio">
                    No has definido presupuestos para {periodoMes}.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {resumen.estadoPresupuestos.map((p) => (
                      <div key={p.presupuestoId} className="kpi-box">
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem' }}>
                          <strong>{p.nombreCategoria}</strong>
                          <span>
                            {formatearMonto(p.gastadoCentimos, 'PEN')} /{' '}
                            {formatearMonto(p.limiteCentimos, 'PEN')}
                          </span>
                        </div>
                        <div className="barra-progreso">
                          <div
                            className={`barra-progreso-fill ${p.excedido ? 'excedido' : ''}`}
                            style={{ width: `${Math.min(100, p.porcentajeUsadoBasisPoints / 100)}%` }}
                          />
                        </div>
                        <div style={{ marginTop: '4px', fontSize: '0.78rem', color: p.excedido ? '#b91c1c' : '#475569' }}>
                          {p.excedido
                            ? `Excedido por ${formatearMonto(Math.abs(p.disponibleCentimos), 'PEN')}`
                            : `Disponible: ${formatearMonto(p.disponibleCentimos, 'PEN')}`}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        {/* ==================== VISTA ANALÍTICA AVANZADA ==================== */}
        {vista === 'analitica' && (
          <PanelAnaliticaAvanzada
            instantanea={instantanea}
            periodoMesInicial={periodoMes}
            onNavegarAMovimientosConFiltro={(opciones) => {
              setMostrarPapelera(false);
              setFiltroCategoriaId(opciones.categoriaId ?? '');
              setFiltroEventoId(opciones.eventoId ?? '');
              setFiltroEtiqueta('');
              setFiltroTexto('');
              setVista('movimientos');
            }}
          />
        )}

        {/* ==================== VISTA PREDICCIONES Y RIESGO FINANCIERO ==================== */}
        {vista === 'predicciones' && (
          <PanelPrediccionesYRiesgo
            instantanea={instantanea}
            periodoMes={periodoMes}
            onIrAMovimiento={(movId, catId) => {
              setMostrarPapelera(false);
              setFiltroCategoriaId(catId ?? '');
              setFiltroEventoId('');
              setFiltroEtiqueta('');
              setFiltroTexto(movId ?? '');
              setVista('movimientos');
            }}
          />
        )}

        {/* ==================== VISTA EVENTOS UNIVERSALES, PRESUPUESTOS Y COMPARTIDOS ==================== */}
        {vista === 'eventos' && (
          <PanelEventosUniversal
            instantanea={instantanea}
            repositorio={repositorio}
            onRecargar={recargar}
          />
        )}

        {/* ==================== VISTA CALENDARIO Y REGLAS DE RECURRENCIA ==================== */}
        {vista === 'calendario' && (
          <PanelCalendarioYRecurrentes
            instantanea={instantanea}
            periodoMes={periodoMes}
            repositorio={repositorio}
            onRecargar={recargar}
          />
        )}

        {/* ==================== VISTA LIBRO COMPLETO DE MOVIMIENTOS Y PAPELERA ==================== */}
        {vista === 'movimientos' && (
          <section className="card">
            <div className="card-title">
              <span>{mostrarPapelera ? 'Papelera (eliminación lógica)' : 'Todos los movimientos registrados'}</span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className={`chip-btn ${mostrarPapelera ? 'seleccionado' : ''}`}
                  onClick={() => setMostrarPapelera((v) => !v)}
                >
                  {mostrarPapelera ? 'Ver activos' : 'Ver papelera'}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '12px' }}>
              <input
                type="search"
                className="input-control"
                placeholder="Buscar descripción, cuenta, #etiqueta..."
                value={filtroTexto}
                onChange={(e) => setFiltroTexto(e.target.value)}
              />
              <select
                className="input-control"
                value={filtroEventoId}
                onChange={(e) => setFiltroEventoId(e.target.value)}
              >
                <option value="">Todos los eventos</option>
                {instantanea.eventos
                  .filter((e) => e.estado === 'ACTIVO')
                  .map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      Evento: {ev.nombre}
                    </option>
                  ))}
              </select>
              <select
                className="input-control"
                value={filtroCategoriaId}
                onChange={(e) => setFiltroCategoriaId(e.target.value)}
              >
                <option value="">Todas las categorías</option>
                {categoriasActivas
                  .filter((c) => c.padreId === null)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nombre}
                    </option>
                  ))}
              </select>
              <input
                type="date"
                className="input-control"
                value={filtroDesde}
                onChange={(e) => setFiltroDesde(e.target.value)}
                aria-label="Desde fecha"
              />
              <input
                type="date"
                className="input-control"
                value={filtroHasta}
                onChange={(e) => setFiltroHasta(e.target.value)}
                aria-label="Hasta fecha"
              />
              {etiquetasConocidas.length > 0 && (
                <select
                  className="input-control"
                  value={filtroEtiqueta}
                  onChange={(e) => setFiltroEtiqueta(e.target.value)}
                >
                  <option value="">Todas las etiquetas</option>
                  {etiquetasConocidas.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {movimientosFiltrados.length === 0 ? (
              <div className="estado-vacio">No hay movimientos que coincidan con el filtro actual.</div>
            ) : (
              <div className="lista-movimientos">{movimientosFiltrados.map(renderItemMovimiento)}</div>
            )}
          </section>
        )}

        {/* ==================== VISTA CATÁLOGOS ==================== */}
        {vista === 'catalogos' && (
          <PanelConfiguracionCatalogos
            instantanea={instantanea}
            saldosPorCuenta={resumen.saldosPorCuenta}
            periodoMes={periodoMes}
            repositorio={repositorio}
            onRecargar={recargar}
          />
        )}

        {/* ==================== VISTA IMPORTACIÓN Y EXPORTACIÓN ==================== */}
        {vista === 'intercambio' && (
          <PanelImportarExportar
            instantanea={instantanea}
            repositorio={repositorio}
            onRecargar={recargar}
          />
        )}

        {/* ==================== VISTA SINCRONIZACIÓN MULTIDISPOSITIVO, SEGURIDAD Y PWA ==================== */}
        {vista === 'sincronizacion' && (
          <PanelSincronizacionYPwa
            instantanea={instantanea}
            repositorio={repositorio}
            onRecargar={recargar}
            clienteSupabase={clienteSupabase}
            sesionExterna={sesionCloud}
            onCambioSesion={async (nuevaSesion) => {
              setSesionCloud(nuevaSesion);
              if (repositorio.guardarSesionCloudPersistente) {
                await repositorio.guardarSesionCloudPersistente(nuevaSesion);
              }
            }}
            verificadorBloqueo={verificadorBloqueo}
            onConfigurarBloqueo={async (ver) => {
              setVerificadorBloqueo(ver);
              if (repositorio.guardarVerificadorBloqueoLocal) {
                await repositorio.guardarVerificadorBloqueoLocal(ver);
              }
            }}
            onActivarBloqueoAhora={() => {
              if (verificadorBloqueo) setBloqueado(true);
            }}
          />
        )}

        {/* ==================== VISTA AUDITORÍA Y TRAZABILIDAD ==================== */}
        {vista === 'auditoria' && (
          <section className="card">
            <h3 className="card-title">Registro inmutable de auditoría y cola de sincronización</h3>
            <p style={{ marginTop: 0, fontSize: '0.88rem', color: '#475569' }}>
              Cambios pendientes en cola desacoplada para Supabase:{' '}
              <strong>{instantanea.cambiosPendientesSync}</strong>
            </p>
            {auditoria.length === 0 ? (
              <div className="estado-vacio">Todavía no se han registrado eventos en la auditoría.</div>
            ) : (
              <div className="lista-movimientos">
                {auditoria.map((ev) => (
                  <div key={ev.id} className="item-movimiento" style={{ fontSize: '0.84rem' }}>
                    <div>
                      <span className="badge badge-origen">{ev.accion}</span>{' '}
                      <strong>
                        {ev.entidad} / {ev.registroId}
                      </strong>
                    </div>
                    <div style={{ color: '#64748b' }}>{fechaHoraLima(ev.ocurridoEn)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* ==================== BOTÓN FLOTANTE (+) Y NAVEGACIÓN INFERIOR MÓVIL ==================== */}
      <button
        type="button"
        className="fab-registrar"
        aria-label="Registrar nuevo movimiento"
        title="Registrar movimiento rápido"
        onClick={() => {
          setMovimientoEditar(null);
          setModalAbierto(true);
        }}
      >
        +
      </button>

      <nav className="mobile-bottom-nav" aria-label="Navegación inferior móvil">
        {(
          [
            { id: 'dashboard', icono: '▣', texto: 'Inicio' },
            { id: 'analitica', icono: '📊', texto: 'Analítica' },
            { id: 'predicciones', icono: '📈', texto: 'Riesgo' },
            { id: 'eventos', icono: '★', texto: 'Eventos' },
            { id: 'calendario', icono: '📅', texto: 'Agenda' },
            { id: 'movimientos', icono: '⇄', texto: 'Movs' },
            { id: 'sincronizacion', icono: '☁', texto: 'Sync/PWA' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mobile-nav-btn ${vista === item.id ? 'activo' : ''}`}
            onClick={() => setVista(item.id)}
          >
            <span aria-hidden="true" style={{ fontSize: '1.1rem' }}>
              {item.icono}
            </span>
            <span>{item.texto}</span>
          </button>
        ))}
      </nav>

      {/* ==================== MODAL / HOJA DE REGISTRO RÁPIDO ==================== */}
      {modalAbierto && (
        <FormularioMovimientoRapido
          cuentasActivas={cuentasActivas}
          categoriasActivas={categoriasActivas}
          eventosActivos={eventosActivosParaFormulario}
          etiquetasConocidas={etiquetasConocidas}
          movimientoEditar={movimientoEditar}
          onGuardarNuevo={async (entrada) => {
            await repositorio.registrarMovimiento(entrada);
            await recargar();
          }}
          onGuardarEdicion={async (entrada) => {
            await repositorio.editarMovimiento(entrada);
            await recargar();
          }}
          onActivarCatalogosRapidos={async () => {
            await repositorio.activarMetodosInicialesSugeridos();
            await repositorio.activarCategoriasInicialesSugeridas();
            await recargar();
          }}
          onCerrar={() => {
            setModalAbierto(false);
            setMovimientoEditar(null);
          }}
        />
      )}
    </div>
  );
};
