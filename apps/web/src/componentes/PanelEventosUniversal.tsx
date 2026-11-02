import React, { useMemo, useState } from 'react';
import {
  aTextoDecimal,
  calcularResumenEvento,
  calcularSaldosYDeudasCompartidas,
  CATALOGO_MONEDAS,
  construirCuotasEquitativas,
  construirCuotasPorPorcentaje,
  ESTADOS_EVENTO_UNIVERSAL,
  type EstadoEventoUniversal,
  type EventoUniversal,
  formatearMonto,
  hoyLima,
  parsearMonto,
  parsearTextoEtiquetas,
  type ParticipanteEvento,
  type PartidaPresupuestoEvento,
  sumarDias,
  TIPOS_EVENTO_INICIALES,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio, RepositorioFinanciero } from '../persistencia/puerto';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  repositorio: RepositorioFinanciero;
  onRecargar: () => Promise<void>;
  onAbrirRegistroMovimientoParaEvento?: (eventoId: string) => void;
}

export const PanelEventosUniversal: React.FC<Props> = ({
  instantanea,
  repositorio,
  onRecargar,
}) => {
  const [eventoSeleccionadoId, setEventoSeleccionadoId] = useState<string | null>(null);
  const [filtroEstadoEvento, setFiltroEstadoEvento] = useState<string>('TODOS');
  const [pestanaDetalle, setPestanaDetalle] = useState<
    'presupuesto' | 'planificacion' | 'compartidos' | 'movimientos'
  >('presupuesto');

  // Formulario Crear Nuevo Evento Universal
  const [mostrarFormNuevoEvento, setMostrarFormNuevoEvento] = useState<boolean>(false);
  const [nombreEv, setNombreEv] = useState('');
  const [tipoEv, setTipoEv] = useState('VIAJE');
  const [tipoPersonalizadoEv, setTipoPersonalizadoEv] = useState('');
  const [fechaInicioEv, setFechaInicioEv] = useState(hoyLima());
  const [fechaFinEv, setFechaFinEv] = useState(() => sumarDias(hoyLima(), 10));
  const [ubicacionEv, setUbicacionEv] = useState('');
  const [presupuestoEvTexto, setPresupuestoEvTexto] = useState('');
  const [monedaEv, setMonedaEv] = useState('PEN');
  const [etiquetasEvTexto, setEtiquetasEvTexto] = useState('');
  const [descripcionEv, setDescripcionEv] = useState('');
  const [estadoEvInicial, setEstadoEvInicial] = useState<EstadoEventoUniversal>('PLANIFICADO');

  // Formulario Partidas dentro del evento seleccionado
  const [nuevaPartidaNombre, setNuevaPartidaNombre] = useState('');
  const [nuevaPartidaMontoTexto, setNuevaPartidaMontoTexto] = useState('');

  // Formulario Planificación (Gasto planificado / comprometido)
  const [conceptoPlan, setConceptoPlan] = useState('');
  const [montoPlanTexto, setMontoPlanTexto] = useState('');
  const [fechaPlan, setFechaPlan] = useState(hoyLima());
  const [partidaPlanId, setPartidaPlanId] = useState('');
  const [estadoPlanInicial, setEstadoPlanInicial] = useState<'PLANIFICADO' | 'COMPROMETIDO'>(
    'PLANIFICADO',
  );
  // Conversión de planificado a movimiento real
  const [planAConvertirId, setPlanAConvertirId] = useState<string | null>(null);
  const [cuentaConversionId, setCuentaConversionId] = useState('');
  const [categoriaConversionId, setCategoriaConversionId] = useState('');

  // Formulario Participantes y Gastos Compartidos
  const [nuevoParticipanteNombre, setNuevoParticipanteNombre] = useState('');
  const [descCompartido, setDescCompartido] = useState('');
  const [montoCompartidoTexto, setMontoCompartidoTexto] = useState('');
  const [fechaCompartido, setFechaCompartido] = useState(hoyLima());
  const [pagadorCompartidoId, setPagadorCompartidoId] = useState('yo');
  const [modoDivision, setModoDivision] = useState<'EQUITATIVO' | 'PORCENTAJE'>('EQUITATIVO');
  const [porcentajesInput, setPorcentajesInput] = useState<Record<string, string>>({});
  const [registrarEnMiCuentaAlPagar, setRegistrarEnMiCuentaAlPagar] = useState(true);
  const [cuentaGastoCompId, setCuentaGastoCompId] = useState('');
  const [categoriaGastoCompId, setCategoriaGastoCompId] = useState('');

  // Formulario Liquidación / Pago parcial
  const [deudorLiqId, setDeudorLiqId] = useState('');
  const [acreedorLiqId, setAcreedorLiqId] = useState('');
  const [montoLiqTexto, setMontoLiqTexto] = useState('');
  const [notaLiq, setNotaLiq] = useState('');

  // Filtros de movimientos reales dentro del evento
  const [filtroFechaDesdeMov, setFiltroFechaDesdeMov] = useState('');
  const [filtroFechaHastaMov, setFiltroFechaHastaMov] = useState('');
  const [filtroCategoriaMov, setFiltroCategoriaMov] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const eventosActivos = useMemo(
    () => instantanea.eventos.filter((e) => e.estado === 'ACTIVO'),
    [instantanea.eventos],
  );
  const cuentasActivas = useMemo(
    () => instantanea.cuentas.filter((c) => c.estado === 'ACTIVO'),
    [instantanea.cuentas],
  );
  const categoriasGastoActivas = useMemo(
    () =>
      instantanea.categorias.filter(
        (c) => c.estado === 'ACTIVO' && c.padreId === null && c.naturaleza === 'GASTO',
      ),
    [instantanea.categorias],
  );
  const mapaNombresCategorias = useMemo(
    () => new Map(instantanea.categorias.map((c) => [c.id, c.nombre])),
    [instantanea.categorias],
  );
  const mapaNombresCuentas = useMemo(
    () => new Map(instantanea.cuentas.map((c) => [c.id, c.nombre])),
    [instantanea.cuentas],
  );

  const eventoSeleccionado: EventoUniversal | null = useMemo(
    () => eventosActivos.find((e) => e.id === eventoSeleccionadoId) ?? null,
    [eventosActivos, eventoSeleccionadoId],
  );

  const resumenEventoSeleccionado = useMemo(() => {
    if (!eventoSeleccionado) return null;
    return calcularResumenEvento({
      evento: eventoSeleccionado,
      movimientos: instantanea.movimientos,
      gastosPlanificados: instantanea.gastosPlanificados,
      mapaNombresCategorias,
      fechaReferenciaLima: hoyLima(),
    });
  }, [
    eventoSeleccionado,
    instantanea.movimientos,
    instantanea.gastosPlanificados,
    mapaNombresCategorias,
  ]);

  const resumenCompartidosEvento = useMemo(() => {
    const participantes = eventoSeleccionado?.participantes ?? [
      { id: 'yo', nombre: 'Yo', esUsuarioTitular: true },
    ];
    const gastos = instantanea.gastosCompartidos.filter(
      (g) =>
        g.estado === 'ACTIVO' &&
        (eventoSeleccionado ? g.eventoId === eventoSeleccionado.id : true),
    );
    const liquidaciones = instantanea.liquidacionesCompartidas.filter(
      (l) =>
        l.estado === 'ACTIVO' &&
        (eventoSeleccionado ? l.eventoId === eventoSeleccionado.id : true),
    );
    return calcularSaldosYDeudasCompartidas({
      participantes,
      gastosCompartidos: gastos,
      liquidaciones,
    });
  }, [
    eventoSeleccionado,
    instantanea.gastosCompartidos,
    instantanea.liquidacionesCompartidas,
  ]);

  const eventosFiltrados = useMemo(() => {
    return eventosActivos.filter((e) =>
      filtroEstadoEvento === 'TODOS' ? true : e.estadoEvento === filtroEstadoEvento,
    );
  }, [eventosActivos, filtroEstadoEvento]);

  // ==================== VISTA DETALLADA DE UN EVENTO ====================
  if (eventoSeleccionado && resumenEventoSeleccionado) {
    const { controlDiario } = resumenEventoSeleccionado;
    const planificadosDelEvento = instantanea.gastosPlanificados.filter(
      (g) => g.estado === 'ACTIVO' && g.eventoId === eventoSeleccionado.id,
    );
    const movimientosFiltradosEvento = resumenEventoSeleccionado.movimientosRealesVinculados.filter(
      (m) => {
        if (filtroFechaDesdeMov && m.fechaMovimiento < filtroFechaDesdeMov) return false;
        if (filtroFechaHastaMov && m.fechaMovimiento > filtroFechaHastaMov) return false;
        if (filtroCategoriaMov && m.categoriaId !== filtroCategoriaMov) return false;
        return true;
      },
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {/* Cabecera del evento seleccionado */}
        <section className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
            <div>
              <button
                type="button"
                className="btn"
                style={{ minHeight: '34px', padding: '4px 10px', marginBottom: '8px', fontSize: '0.82rem' }}
                onClick={() => setEventoSeleccionadoId(null)}
              >
                ← Volver a todos los eventos
              </button>
              <h3 style={{ margin: 0, fontSize: '1.25rem' }}>
                {eventoSeleccionado.nombre}{' '}
                <span className="badge badge-origen">{eventoSeleccionado.tipoEvento}</span>{' '}
                <span className="badge badge-transferencia">{eventoSeleccionado.estadoEvento}</span>
              </h3>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: '4px' }}>
                Fechas: <strong>{eventoSeleccionado.fechaInicio}</strong> al{' '}
                <strong>{eventoSeleccionado.fechaFin}</strong> ({controlDiario.diasTotalesEvento}{' '}
                día(s))
                {eventoSeleccionado.ubicacion && ` · Ubicación: ${eventoSeleccionado.ubicacion}`}
                {' · '}Moneda: <strong>{eventoSeleccionado.moneda}</strong>
              </div>
              {eventoSeleccionado.descripcion && (
                <div style={{ fontSize: '0.86rem', color: '#334155', marginTop: '4px' }}>
                  {eventoSeleccionado.descripcion}
                </div>
              )}
              {eventoSeleccionado.etiquetas.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  {eventoSeleccionado.etiquetas.map((t) => (
                    <span key={t} className="badge badge-tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {ESTADOS_EVENTO_UNIVERSAL.map((est) => (
                <button
                  key={est}
                  type="button"
                  className={`chip-btn ${eventoSeleccionado.estadoEvento === est ? 'seleccionado' : ''}`}
                  onClick={async () => {
                    await repositorio.cambiarEstadoEvento(eventoSeleccionado.id, est);
                    await onRecargar();
                  }}
                >
                  {est}
                </button>
              ))}
            </div>
          </div>

          {/* KPIs Globales del Presupuesto del Evento */}
          <div className="kpi-grid" style={{ marginTop: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))' }}>
            <div className="kpi-box">
              <div className="kpi-label">Presupuesto total</div>
              <div className="kpi-value">
                {formatearMonto(
                  resumenEventoSeleccionado.presupuestoTotalCentimos,
                  eventoSeleccionado.moneda,
                )}
              </div>
            </div>
            <div className="kpi-box">
              <div className="kpi-label">Presupuesto asignado</div>
              <div className="kpi-value">
                {formatearMonto(
                  resumenEventoSeleccionado.presupuestoAsignadoCentimos,
                  eventoSeleccionado.moneda,
                )}
              </div>
            </div>
            <div className="kpi-box">
              <div className="kpi-label">Gasto real registrado</div>
              <div className="kpi-value egreso">
                {formatearMonto(
                  resumenEventoSeleccionado.gastoRealCentimos,
                  eventoSeleccionado.moneda,
                )}
              </div>
            </div>
            <div className="kpi-box">
              <div className="kpi-label">Dinero comprometido</div>
              <div className="kpi-value" style={{ color: '#b45309' }}>
                {formatearMonto(
                  resumenEventoSeleccionado.dineroComprometidoCentimos,
                  eventoSeleccionado.moneda,
                )}
              </div>
            </div>
            <div className="kpi-box">
              <div className="kpi-label">Saldo disponible</div>
              <div className="kpi-value ingreso">
                {formatearMonto(
                  resumenEventoSeleccionado.saldoDisponibleTrasCompromisosCentimos,
                  eventoSeleccionado.moneda,
                )}
              </div>
            </div>
            <div className="kpi-box">
              <div className="kpi-label">% Consumido / Exceso</div>
              <div className="kpi-value">
                {(resumenEventoSeleccionado.porcentajeConsumidoBp / 100).toFixed(1)}%
              </div>
              {resumenEventoSeleccionado.excesoPresupuestarioCentimos > 0 && (
                <div style={{ fontSize: '0.76rem', color: '#b91c1c', fontWeight: 700 }}>
                  Exceso:{' '}
                  {formatearMonto(
                    resumenEventoSeleccionado.excesoPresupuestarioCentimos,
                    eventoSeleccionado.moneda,
                  )}
                </div>
              )}
            </div>
          </div>

          {/* CONTROL DIARIO: Burn Rate vs. Presupuesto Diario Recomendado */}
          <div
            style={{
              marginTop: '14px',
              padding: '12px',
              borderRadius: '10px',
              border: '1px solid #cbd5e1',
              background:
                controlDiario.evaluacionRitmo === 'RITMO_EXCEDIDO' ||
                controlDiario.evaluacionRitmo === 'PRESUPUESTO_AGOTADO'
                  ? '#fff1f2'
                  : '#f0fdf4',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
              <strong>
                Control Diario ({controlDiario.situacionTemporal}) · Transcurridos:{' '}
                {controlDiario.diasTranscurridos}d · Restantes:{' '}
                {controlDiario.diasCalendarioRestantes}d
              </strong>
              <span className="badge badge-origen">{controlDiario.evaluacionRitmo}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginTop: '8px', fontSize: '0.9rem' }}>
              <div>
                Presupuesto diario recomendado:{' '}
                <strong>
                  {formatearMonto(
                    controlDiario.presupuestoDiarioRecomendadoCentimos,
                    eventoSeleccionado.moneda,
                  )}
                  /día
                </strong>
              </div>
              <div>
                Burn Rate diario real:{' '}
                <strong>
                  {formatearMonto(controlDiario.burnRateDiarioCentimos, eventoSeleccionado.moneda)}
                  /día
                </strong>
              </div>
              <div>
                Ritmo objetivo inicial:{' '}
                <strong>
                  {formatearMonto(
                    controlDiario.ritmoObjetivoInicialDiarioCentimos,
                    eventoSeleccionado.moneda,
                  )}
                  /día
                </strong>
              </div>
            </div>
            <div style={{ marginTop: '6px', fontSize: '0.84rem', color: '#334155' }}>
              {controlDiario.mensajeRitmo}
            </div>
          </div>
        </section>

        {error && (
          <div className="aviso-insuficiente" role="alert">
            {error}
          </div>
        )}
        {mensaje && (
          <div style={{ padding: '12px', background: '#dcfce7', color: '#15803d', borderRadius: '10px', fontWeight: 600 }}>
            {mensaje}
          </div>
        )}

        {/* Pestañas de navegación del detalle del evento */}
        <div className="chip-group">
          {(
            [
              { id: 'presupuesto', texto: '1. Categorías y Presupuesto' },
              {
                id: 'planificacion',
                texto: `2. Planificación (${planificadosDelEvento.length})`,
              },
              { id: 'compartidos', texto: '3. Gastos Compartidos y Deudas' },
              {
                id: 'movimientos',
                texto: `4. Movimientos Reales (${resumenEventoSeleccionado.movimientosRealesVinculados.length})`,
              },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              className={`chip-btn ${pestanaDetalle === t.id ? 'seleccionado' : ''}`}
              onClick={() => setPestanaDetalle(t.id)}
            >
              {t.texto}
            </button>
          ))}
        </div>

        {/* PESTAÑA 1: PARTIDAS PRESUPUESTARIAS DEL EVENTO */}
        {pestanaDetalle === 'presupuesto' && (
          <section className="card">
            <h4 className="card-title">
              Categorías y asignaciones presupuestarias de "{eventoSeleccionado.nombre}"
            </h4>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
              {resumenEventoSeleccionado.partidas.map((p) => (
                <div key={p.partidaId} className="kpi-box">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <strong>{p.nombre}</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '0.86rem' }}>
                        Real: <strong>{formatearMonto(p.gastoRealCentimos, eventoSeleccionado.moneda)}</strong>{' '}
                        · Comprometido:{' '}
                        <strong>{formatearMonto(p.comprometidoCentimos, eventoSeleccionado.moneda)}</strong>{' '}
                        / Asignado:{' '}
                        <strong>{formatearMonto(p.asignadoCentimos, eventoSeleccionado.moneda)}</strong>
                      </span>
                      <button
                        type="button"
                        className="btn btn-peligro"
                        style={{ minHeight: '30px', padding: '2px 8px', fontSize: '0.75rem' }}
                        onClick={async () => {
                          const nuevas = eventoSeleccionado.partidasPresupuesto.filter(
                            (x) => x.id !== p.partidaId,
                          );
                          await repositorio.actualizarEvento({
                            id: eventoSeleccionado.id,
                            partidasPresupuesto: nuevas,
                          });
                          await onRecargar();
                        }}
                      >
                        Quitar
                      </button>
                    </div>
                  </div>
                  <div className="barra-progreso">
                    <div
                      className={`barra-progreso-fill ${p.excesoCentimos > 0 ? 'excedido' : ''}`}
                      style={{ width: `${Math.min(100, p.porcentajeConsumidoBp / 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  const monto = parsearMonto(nuevaPartidaMontoTexto || '0', eventoSeleccionado.moneda);
                  const nombreLimpio = nuevaPartidaNombre.trim();
                  if (!nombreLimpio) return;
                  const idxExistente = eventoSeleccionado.partidasPresupuesto.findIndex(
                    (x) => x.nombre.toLowerCase() === nombreLimpio.toLowerCase(),
                  );
                  const nuevas: PartidaPresupuestoEvento[] = [...eventoSeleccionado.partidasPresupuesto];
                  if (idxExistente >= 0) {
                    nuevas[idxExistente] = {
                      ...nuevas[idxExistente]!,
                      asignadoCentimos: monto,
                    };
                  } else {
                    nuevas.push({
                      id: `part-${Date.now()}`,
                      nombre: nombreLimpio,
                      asignadoCentimos: monto,
                    });
                  }
                  await repositorio.actualizarEvento({
                    id: eventoSeleccionado.id,
                    partidasPresupuesto: nuevas,
                  });
                  setNuevaPartidaNombre('');
                  setNuevaPartidaMontoTexto('');
                  await onRecargar();
                  setMensaje('Categoría presupuestaria del evento actualizada.');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}
            >
              <input
                type="text"
                required
                className="input-control"
                placeholder="Categoría (o escribe una existente para cambiar monto)"
                value={nuevaPartidaNombre}
                onChange={(e) => setNuevaPartidaNombre(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                required
                className="input-control"
                placeholder="Presupuesto asignado (ej. 450.00)"
                value={nuevaPartidaMontoTexto}
                onChange={(e) => setNuevaPartidaMontoTexto(e.target.value)}
              />
              <button type="submit" className="btn btn-primario">
                Agregar / Actualizar categoría
              </button>
            </form>
          </section>
        )}

        {/* PESTAÑA 2: PLANIFICACIÓN (PLANIFICADO vs. COMPROMETIDO vs. REGISTRADO) */}
        {pestanaDetalle === 'planificacion' && (
          <section className="card">
            <h4 className="card-title">
              Gastos previstos, actividades y compromisos (Conversión sin doble conteo)
            </h4>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  const centimos = parsearMonto(montoPlanTexto, eventoSeleccionado.moneda);
                  await repositorio.crearGastoPlanificado({
                    eventoId: eventoSeleccionado.id,
                    partidaEventoId: partidaPlanId || null,
                    concepto: conceptoPlan,
                    montoEstimadoCentimos: centimos,
                    fechaPrevista: fechaPlan,
                    estadoPlanificacion: estadoPlanInicial,
                  });
                  setConceptoPlan('');
                  setMontoPlanTexto('');
                  await onRecargar();
                  setMensaje('Ítem de planificación agregado.');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginBottom: '16px' }}
            >
              <input
                type="text"
                required
                className="input-control"
                placeholder="Concepto / Actividad (ej. Reserva hotel)"
                value={conceptoPlan}
                onChange={(e) => setConceptoPlan(e.target.value)}
              />
              <input
                type="text"
                inputMode="decimal"
                required
                className="input-control"
                placeholder="Monto estimado"
                value={montoPlanTexto}
                onChange={(e) => setMontoPlanTexto(e.target.value)}
              />
              <input
                type="date"
                required
                className="input-control"
                value={fechaPlan}
                onChange={(e) => setFechaPlan(e.target.value)}
              />
              <select
                className="input-control"
                value={partidaPlanId}
                onChange={(e) => setPartidaPlanId(e.target.value)}
              >
                <option value="">Sin partida específica</option>
                {eventoSeleccionado.partidasPresupuesto.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}
                  </option>
                ))}
              </select>
              <select
                className="input-control"
                value={estadoPlanInicial}
                onChange={(e) =>
                  setEstadoPlanInicial(e.target.value as 'PLANIFICADO' | 'COMPROMETIDO')
                }
              >
                <option value="PLANIFICADO">Gasto Planificado</option>
                <option value="COMPROMETIDO">Gasto Comprometido (reserva)</option>
              </select>
              <button type="submit" className="btn btn-primario">
                Añadir a planificación
              </button>
            </form>

            {planAConvertirId && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  try {
                    await repositorio.convertirGastoPlanificadoEnMovimientoReal({
                      gastoPlanificadoId: planAConvertirId,
                      cuentaId: cuentaConversionId,
                      categoriaId: categoriaConversionId,
                    });
                    setPlanAConvertirId(null);
                    await onRecargar();
                    setMensaje(
                      'Gasto planificado convertido en transacción real única (sin duplicar importe).',
                    );
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
                style={{ padding: '12px', background: '#eff6ff', borderRadius: '10px', border: '1px solid #93c5fd', marginBottom: '14px' }}
              >
                <strong>Confirmar conversión en transacción real:</strong>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '8px' }}>
                  <select
                    required
                    className="input-control"
                    value={cuentaConversionId}
                    onChange={(e) => setCuentaConversionId(e.target.value)}
                  >
                    <option value="">Selecciona cuenta / método de pago...</option>
                    {cuentasActivas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                      </option>
                    ))}
                  </select>
                  <select
                    required
                    className="input-control"
                    value={categoriaConversionId}
                    onChange={(e) => setCategoriaConversionId(e.target.value)}
                  >
                    <option value="">Selecciona categoría de gasto...</option>
                    {categoriasGastoActivas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nombre}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="btn btn-primario">
                    Confirmar y registrar gasto real
                  </button>
                  <button type="button" className="btn" onClick={() => setPlanAConvertirId(null)}>
                    Cancelar
                  </button>
                </div>
              </form>
            )}

            {planificadosDelEvento.length === 0 ? (
              <div className="estado-vacio">
                Aún no hay gastos planificados ni comprometidos para este evento.
              </div>
            ) : (
              <div className="lista-movimientos">
                {planificadosDelEvento.map((item) => (
                  <div key={item.id} className="item-movimiento">
                    <div>
                      <span className="badge badge-origen">{item.estadoPlanificacion}</span>{' '}
                      <strong>{item.concepto}</strong>
                      <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '4px' }}>
                        Fecha prevista: {item.fechaPrevista}
                        {item.movimientoRealId &&
                          ` · Vinculado a movimiento real #${item.movimientoRealId.slice(0, 8)}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <strong>
                        {formatearMonto(item.montoEstimadoCentimos, eventoSeleccionado.moneda)}
                      </strong>
                      {item.estadoPlanificacion !== 'REGISTRADO' && (
                        <>
                          <button
                            type="button"
                            className="btn"
                            style={{ minHeight: '32px', padding: '4px 8px', fontSize: '0.76rem' }}
                            onClick={async () => {
                              await repositorio.cambiarEstadoGastoPlanificado(
                                item.id,
                                item.estadoPlanificacion === 'PLANIFICADO'
                                  ? 'COMPROMETIDO'
                                  : 'PLANIFICADO',
                              );
                              await onRecargar();
                            }}
                          >
                            Pasar a{' '}
                            {item.estadoPlanificacion === 'PLANIFICADO'
                              ? 'Comprometido'
                              : 'Planificado'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-primario"
                            style={{ minHeight: '32px', padding: '4px 8px', fontSize: '0.76rem' }}
                            onClick={() => {
                              setPlanAConvertirId(item.id);
                              setCuentaConversionId(cuentasActivas[0]?.id ?? '');
                              setCategoriaConversionId(categoriasGastoActivas[0]?.id ?? '');
                            }}
                          >
                            Convertir en gasto real
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* PESTAÑA 3: GASTOS COMPARTIDOS, PARTICIPANTES Y LIQUIDACIONES */}
        {pestanaDetalle === 'compartidos' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Resumen de las 4 magnitudes del usuario titular */}
            <section className="card">
              <div className="card-title">
                <span>Perspectiva contable del usuario (sin inflar ingresos por deudas por cobrar)</span>
                <span className="badge badge-origen">DERIVADO</span>
              </div>
              <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
                <div className="kpi-box">
                  <div className="kpi-label">1. Dinero que salió de mi bolsillo</div>
                  <div className="kpi-value">
                    {formatearMonto(
                      resumenCompartidosEvento.perspectivaUsuario.dineroSalioDeMiBolsilloCentimos,
                      'PEN',
                    )}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">2. Parte del gasto que me corresponde</div>
                  <div className="kpi-value egreso">
                    {formatearMonto(
                      resumenCompartidosEvento.perspectivaUsuario.parteGastoQueMeCorrespondeCentimos,
                      'PEN',
                    )}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">3. Dinero que otras personas me deben</div>
                  <div className="kpi-value ingreso">
                    {formatearMonto(
                      resumenCompartidosEvento.perspectivaUsuario.dineroQueMeDebenCentimos,
                      'PEN',
                    )}
                  </div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">4. Dinero que debo a otras personas</div>
                  <div className="kpi-value egreso">
                    {formatearMonto(
                      resumenCompartidosEvento.perspectivaUsuario.dineroQueDeboCentimos,
                      'PEN',
                    )}
                  </div>
                </div>
              </div>

              {/* Quién debe a quién */}
              <div style={{ marginTop: '14px' }}>
                <strong>Liquidaciones pendientes (quién debe a quién):</strong>
                {resumenCompartidosEvento.quienDebeAQuien.length === 0 ? (
                  <div style={{ fontSize: '0.88rem', color: '#15803d', marginTop: '6px' }}>
                    Todos los participantes están al día (sin saldos pendientes).
                  </div>
                ) : (
                  <div className="chip-group" style={{ marginTop: '8px' }}>
                    {resumenCompartidosEvento.quienDebeAQuien.map((inst) => (
                      <div key={`${inst.deudorId}-${inst.acreedorId}`} className="kpi-box">
                        <strong>{inst.nombreDeudor}</strong> debe a{' '}
                        <strong>{inst.nombreAcreedor}</strong>:{' '}
                        <span style={{ color: '#b91c1c', fontWeight: 800 }}>
                          {formatearMonto(inst.montoPendienteCentimos, 'PEN')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Agregar participantes al evento */}
            <section className="card">
              <h4 className="card-title">Participantes del grupo ({eventoSeleccionado.participantes.length})</h4>
              <div className="chip-group" style={{ marginBottom: '12px' }}>
                {eventoSeleccionado.participantes.map((p) => (
                  <span key={p.id} className="badge badge-origen" style={{ fontSize: '0.85rem', padding: '6px 12px' }}>
                    {p.nombre} {p.esUsuarioTitular ? '(Titular)' : ''}
                  </span>
                ))}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const nom = nuevoParticipanteNombre.trim();
                  if (!nom) return;
                  const nuevo: ParticipanteEvento = {
                    id: `part-${Date.now()}`,
                    nombre: nom,
                    esUsuarioTitular: false,
                  };
                  await repositorio.actualizarEvento({
                    id: eventoSeleccionado.id,
                    participantes: [...eventoSeleccionado.participantes, nuevo],
                  });
                  setNuevoParticipanteNombre('');
                  await onRecargar();
                }}
                style={{ display: 'flex', gap: '10px' }}
              >
                <input
                  type="text"
                  required
                  className="input-control"
                  style={{ flex: 1 }}
                  placeholder="Nombre del participante (ej. Ana, Carlos...)"
                  value={nuevoParticipanteNombre}
                  onChange={(e) => setNuevoParticipanteNombre(e.target.value)}
                />
                <button type="submit" className="btn btn-primario">
                  Añadir participante
                </button>
              </form>
            </section>

            {/* Registrar gasto compartido */}
            <section className="card">
              <h4 className="card-title">Registrar gasto compartido</h4>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  try {
                    const total = parsearMonto(montoCompartidoTexto, 'PEN');
                    const idsPart = eventoSeleccionado.participantes.map((p) => p.id);
                    const cuotas =
                      modoDivision === 'EQUITATIVO'
                        ? construirCuotasEquitativas(total, idsPart)
                        : construirCuotasPorPorcentaje(
                            total,
                            eventoSeleccionado.participantes.map((p) => ({
                              participanteId: p.id,
                              porcentajeBp: Math.round(
                                Number(porcentajesInput[p.id] ?? '0') * 100,
                              ),
                            })),
                          );

                    const pagadorEsTitular = eventoSeleccionado.participantes.find(
                      (p) => p.id === pagadorCompartidoId,
                    )?.esUsuarioTitular;

                    await repositorio.registrarGastoCompartido({
                      eventoId: eventoSeleccionado.id,
                      descripcion: descCompartido,
                      fechaGasto: fechaCompartido,
                      importeTotalCentimos: total,
                      pagadoPorParticipanteId: pagadorCompartidoId,
                      cuotas,
                      registroEnMiCuenta:
                        pagadorEsTitular && registrarEnMiCuentaAlPagar && cuentaGastoCompId && categoriaGastoCompId
                          ? {
                              cuentaId: cuentaGastoCompId,
                              categoriaId: categoriaGastoCompId,
                              etiquetas: ['#Compartido'],
                            }
                          : null,
                    });
                    setDescCompartido('');
                    setMontoCompartidoTexto('');
                    await onRecargar();
                    setMensaje('Gasto compartido registrado y dividido correctamente.');
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
                  <input
                    type="text"
                    required
                    className="input-control"
                    placeholder="Descripción (ej. Cena grupal, Taxi...)"
                    value={descCompartido}
                    onChange={(e) => setDescCompartido(e.target.value)}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    className="input-control"
                    placeholder="Importe total S/"
                    value={montoCompartidoTexto}
                    onChange={(e) => setMontoCompartidoTexto(e.target.value)}
                  />
                  <input
                    type="date"
                    required
                    className="input-control"
                    value={fechaCompartido}
                    onChange={(e) => setFechaCompartido(e.target.value)}
                  />
                  <select
                    className="input-control"
                    value={pagadorCompartidoId}
                    onChange={(e) => setPagadorCompartidoId(e.target.value)}
                  >
                    {eventoSeleccionado.participantes.map((p) => (
                      <option key={p.id} value={p.id}>
                        Pagó: {p.nombre}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input-control"
                    value={modoDivision}
                    onChange={(e) =>
                      setModoDivision(e.target.value as 'EQUITATIVO' | 'PORCENTAJE')
                    }
                  >
                    <option value="EQUITATIVO">División equitativa</option>
                    <option value="PORCENTAJE">División por porcentaje (%)</option>
                  </select>
                </div>

                {modoDivision === 'PORCENTAJE' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
                    {eventoSeleccionado.participantes.map((p) => (
                      <div key={p.id} className="campo-form" style={{ marginBottom: 0 }}>
                        <label>% para {p.nombre}</label>
                        <input
                          type="number"
                          step="0.01"
                          className="input-control"
                          value={porcentajesInput[p.id] ?? ''}
                          onChange={(e) =>
                            setPorcentajesInput((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}

                {eventoSeleccionado.participantes.find((p) => p.id === pagadorCompartidoId)
                  ?.esUsuarioTitular && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.86rem', fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={registrarEnMiCuentaAlPagar}
                        onChange={(e) => setRegistrarEnMiCuentaAlPagar(e.target.checked)}
                      />
                      Descontar el desembolso de mi cuenta real
                    </label>
                    {registrarEnMiCuentaAlPagar && (
                      <>
                        <select
                          className="input-control"
                          value={cuentaGastoCompId}
                          onChange={(e) => setCuentaGastoCompId(e.target.value)}
                        >
                          <option value="">Cuenta de pago...</option>
                          {cuentasActivas.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                        <select
                          className="input-control"
                          value={categoriaGastoCompId}
                          onChange={(e) => setCategoriaGastoCompId(e.target.value)}
                        >
                          <option value="">Categoría de gasto...</option>
                          {categoriasGastoActivas.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.nombre}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}

                <button type="submit" className="btn btn-primario">
                  Guardar gasto compartido
                </button>
              </form>
            </section>

            {/* Registrar pago parcial o liquidación */}
            <section className="card">
              <h4 className="card-title">Registrar pago parcial o liquidación entre participantes</h4>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  try {
                    const monto = parsearMonto(montoLiqTexto, 'PEN');
                    await repositorio.registrarLiquidacionCompartida({
                      eventoId: eventoSeleccionado.id,
                      fechaLiquidacion: hoyLima(),
                      deudorParticipanteId: deudorLiqId,
                      acreedorParticipanteId: acreedorLiqId,
                      montoCentimos: monto,
                      nota: notaLiq || null,
                    });
                    setMontoLiqTexto('');
                    setNotaLiq('');
                    await onRecargar();
                    setMensaje('Liquidación registrada y saldos recalculados.');
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}
              >
                <select
                  required
                  className="input-control"
                  value={deudorLiqId}
                  onChange={(e) => setDeudorLiqId(e.target.value)}
                >
                  <option value="">Quién paga (deudor)...</option>
                  {eventoSeleccionado.participantes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                <select
                  required
                  className="input-control"
                  value={acreedorLiqId}
                  onChange={(e) => setAcreedorLiqId(e.target.value)}
                >
                  <option value="">Quién recibe (acreedor)...</option>
                  {eventoSeleccionado.participantes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  inputMode="decimal"
                  required
                  className="input-control"
                  placeholder="Monto abonado S/"
                  value={montoLiqTexto}
                  onChange={(e) => setMontoLiqTexto(e.target.value)}
                />
                <input
                  type="text"
                  className="input-control"
                  placeholder="Nota (ej. Pago parcial por Yape)"
                  value={notaLiq}
                  onChange={(e) => setNotaLiq(e.target.value)}
                />
                <button type="submit" className="btn btn-primario">
                  Registrar liquidación
                </button>
              </form>
            </section>
          </div>
        )}

        {/* PESTAÑA 4: MOVIMIENTOS REALES DEL EVENTO CON FILTROS POR FECHA Y CATEGORÍA */}
        {pestanaDetalle === 'movimientos' && (
          <section className="card">
            <h4 className="card-title">
              Movimientos reales vinculados a "{eventoSeleccionado.nombre}" (event_id)
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '12px' }}>
              <input
                type="date"
                className="input-control"
                value={filtroFechaDesdeMov}
                onChange={(e) => setFiltroFechaDesdeMov(e.target.value)}
                aria-label="Filtrar desde fecha"
              />
              <input
                type="date"
                className="input-control"
                value={filtroFechaHastaMov}
                onChange={(e) => setFiltroFechaHastaMov(e.target.value)}
                aria-label="Filtrar hasta fecha"
              />
              <select
                className="input-control"
                value={filtroCategoriaMov}
                onChange={(e) => setFiltroCategoriaMov(e.target.value)}
              >
                <option value="">Todas las categorías</option>
                {categoriasGastoActivas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </div>

            {movimientosFiltradosEvento.length === 0 ? (
              <div className="estado-vacio">
                No hay transacciones reales registradas para este filtro en el evento.
              </div>
            ) : (
              <div className="lista-movimientos">
                {movimientosFiltradosEvento.map((m) => (
                  <div key={m.id} className="item-movimiento">
                    <div>
                      <span className="badge badge-gasto">{m.tipo}</span>{' '}
                      <span className="badge badge-origen">{m.auditoria.origen}</span>{' '}
                      <strong>
                        {mapaNombresCategorias.get(m.categoriaId ?? '') ?? 'Categoría'} ·{' '}
                        {mapaNombresCuentas.get(m.cuentaId) ?? 'Cuenta'}
                      </strong>
                      {m.descripcion && <div style={{ marginTop: '4px' }}>{m.descripcion}</div>}
                      <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '4px' }}>
                        Fecha movimiento: {m.fechaMovimiento} {m.horaMovimiento}
                      </div>
                    </div>
                    <strong style={{ color: '#b91c1c' }}>
                      -{formatearMonto(m.montoCentimos, 'PEN')}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    );
  }

  // ==================== PANTALLA GENERAL DE EVENTOS ====================
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <section className="card">
        <div className="card-title">
          <span>Gestión Universal de Eventos y Presupuestos ({eventosActivos.length})</span>
          <button
            type="button"
            className="btn btn-primario"
            onClick={() => setMostrarFormNuevoEvento((v) => !v)}
          >
            {mostrarFormNuevoEvento ? 'Ocultar formulario' : '+ Crear nuevo evento'}
          </button>
        </div>

        <div className="chip-group" style={{ marginBottom: '12px' }}>
          {(['TODOS', ...ESTADOS_EVENTO_UNIVERSAL] as const).map((est) => (
            <button
              key={est}
              type="button"
              className={`chip-btn ${filtroEstadoEvento === est ? 'seleccionado' : ''}`}
              onClick={() => setFiltroEstadoEvento(est)}
            >
              {est}
            </button>
          ))}
        </div>

        {mostrarFormNuevoEvento && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const pres = presupuestoEvTexto.trim()
                  ? parsearMonto(presupuestoEvTexto, monedaEv)
                  : 0;
                const tipoFinal =
                  tipoEv === 'OTRO' && tipoPersonalizadoEv.trim()
                    ? tipoPersonalizadoEv.trim()
                    : tipoEv;
                const creado = await repositorio.crearEvento({
                  nombre: nombreEv,
                  tipoEvento: tipoFinal,
                  fechaInicio: fechaInicioEv,
                  fechaFin: fechaFinEv,
                  ubicacion: ubicacionEv || null,
                  presupuestoTotalCentimos: pres,
                  moneda: monedaEv,
                  etiquetas: parsearTextoEtiquetas(etiquetasEvTexto),
                  descripcion: descripcionEv || null,
                  estadoEvento: estadoEvInicial,
                  incluirPlantillaViaje: tipoFinal.toUpperCase() === 'VIAJE',
                });
                setNombreEv('');
                setUbicacionEv('');
                setPresupuestoEvTexto('');
                setEtiquetasEvTexto('');
                setDescripcionEv('');
                setMostrarFormNuevoEvento(false);
                await onRecargar();
                setEventoSeleccionadoId(creado.id);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            style={{
              padding: '14px',
              background: '#f8fafc',
              borderRadius: '12px',
              border: '1px solid #cbd5e1',
              marginBottom: '16px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '10px',
            }}
          >
            <input
              type="text"
              required
              className="input-control"
              placeholder="Nombre del evento (cualquier destino o proyecto)"
              value={nombreEv}
              onChange={(e) => setNombreEv(e.target.value)}
            />
            <select
              className="input-control"
              value={tipoEv}
              onChange={(e) => setTipoEv(e.target.value)}
            >
              {TIPOS_EVENTO_INICIALES.map((t) => (
                <option key={t} value={t}>
                  Tipo: {t}
                </option>
              ))}
            </select>
            {tipoEv === 'OTRO' && (
              <input
                type="text"
                required
                className="input-control"
                placeholder="Escribe tu tipo de evento personalizado"
                value={tipoPersonalizadoEv}
                onChange={(e) => setTipoPersonalizadoEv(e.target.value)}
              />
            )}
            <input
              type="date"
              required
              className="input-control"
              value={fechaInicioEv}
              onChange={(e) => setFechaInicioEv(e.target.value)}
            />
            <input
              type="date"
              required
              className="input-control"
              value={fechaFinEv}
              onChange={(e) => setFechaFinEv(e.target.value)}
            />
            <input
              type="text"
              className="input-control"
              placeholder="Ubicación (opcional)"
              value={ubicacionEv}
              onChange={(e) => setUbicacionEv(e.target.value)}
            />
            <input
              type="text"
              inputMode="decimal"
              className="input-control"
              placeholder="Presupuesto total (ej. 1500.00)"
              value={presupuestoEvTexto}
              onChange={(e) => setPresupuestoEvTexto(e.target.value)}
            />
            <select
              className="input-control"
              value={monedaEv}
              onChange={(e) => setMonedaEv(e.target.value)}
            >
              {CATALOGO_MONEDAS.map((m) => (
                <option key={m.codigo} value={m.codigo}>
                  Moneda: {m.codigo} ({m.simbolo})
                </option>
              ))}
            </select>
            <select
              className="input-control"
              value={estadoEvInicial}
              onChange={(e) => setEstadoEvInicial(e.target.value as EstadoEventoUniversal)}
            >
              {ESTADOS_EVENTO_UNIVERSAL.map((est) => (
                <option key={est} value={est}>
                  Estado: {est}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="input-control"
              placeholder="Etiquetas (ej. #Vacaciones #Familiar)"
              value={etiquetasEvTexto}
              onChange={(e) => setEtiquetasEvTexto(e.target.value)}
            />
            <input
              type="text"
              className="input-control"
              placeholder="Descripción (opcional)"
              value={descripcionEv}
              onChange={(e) => setDescripcionEv(e.target.value)}
            />
            <button type="submit" className="btn btn-primario">
              Crear evento
            </button>
          </form>
        )}

        {error && (
          <div className="aviso-insuficiente" role="alert" style={{ marginBottom: '12px' }}>
            {error}
          </div>
        )}

        {eventosFiltrados.length === 0 ? (
          <div className="estado-vacio">
            No hay eventos registrados en este filtro. Puedes crear viajes de cualquier duración,
            celebraciones, compras importantes, proyectos o actividades personales.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
            {eventosFiltrados.map((ev) => {
              const res = calcularResumenEvento({
                evento: ev,
                movimientos: instantanea.movimientos,
                gastosPlanificados: instantanea.gastosPlanificados,
                mapaNombresCategorias,
                fechaReferenciaLima: hoyLima(),
              });
              return (
                <article key={ev.id} className="kpi-box" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{ev.nombre}</strong>
                    <span className="badge badge-transferencia">{ev.estadoEvento}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                    {ev.tipoEvento} · {ev.fechaInicio} → {ev.fechaFin} ({res.controlDiario.diasTotalesEvento}d)
                    {ev.ubicacion ? ` · ${ev.ubicacion}` : ''}
                  </div>
                  <div style={{ fontSize: '0.86rem' }}>
                    Gasto real: <strong>{formatearMonto(res.gastoRealCentimos, ev.moneda)}</strong> /{' '}
                    {formatearMonto(res.presupuestoTotalCentimos, ev.moneda)} (
                    {(res.porcentajeConsumidoBp / 100).toFixed(1)}%)
                  </div>
                  <div className="barra-progreso">
                    <div
                      className={`barra-progreso-fill ${res.excesoPresupuestarioCentimos > 0 ? 'excedido' : ''}`}
                      style={{ width: `${Math.min(100, res.porcentajeConsumidoBp / 100)}%` }}
                    />
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#334155' }}>
                    Recomendado hoy:{' '}
                    <strong>
                      {formatearMonto(res.controlDiario.presupuestoDiarioRecomendadoCentimos, ev.moneda)}
                      /día
                    </strong>{' '}
                    · Burn rate:{' '}
                    <strong>
                      {formatearMonto(res.controlDiario.burnRateDiarioCentimos, ev.moneda)}/día
                    </strong>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button
                      type="button"
                      className="btn btn-primario"
                      style={{ flex: 1, minHeight: '36px', fontSize: '0.82rem' }}
                      onClick={() => setEventoSeleccionadoId(ev.id)}
                    >
                      Abrir vista detallada
                    </button>
                    <button
                      type="button"
                      className="btn btn-peligro"
                      style={{ minHeight: '36px', fontSize: '0.82rem' }}
                      onClick={async () => {
                        await repositorio.eliminarEventoLogicamente(ev.id);
                        await onRecargar();
                      }}
                    >
                      Eliminar
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
