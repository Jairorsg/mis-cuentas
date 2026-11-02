import React, { useMemo, useState } from 'react';
import {
  construirAgendaCalendario,
  finDeMes,
  formatearMonto,
  FRECUENCIAS_RECURRENCIA,
  type FrecuenciaRecurrencia,
  hoyLima,
  inicioDeMes,
  parsearMonto,
  proyectarOcurrenciasRegla,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio, RepositorioFinanciero } from '../persistencia/puerto';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  periodoMes: string;
  repositorio: RepositorioFinanciero;
  onRecargar: () => Promise<void>;
}

export const PanelCalendarioYRecurrentes: React.FC<Props> = ({
  instantanea,
  periodoMes,
  repositorio,
  onRecargar,
}) => {
  const [nombreRegla, setNombreRegla] = useState('');
  const [tipoRegla, setTipoRegla] = useState<'GASTO' | 'INGRESO'>('GASTO');
  const [montoReglaTexto, setMontoReglaTexto] = useState('');
  const [frecuencia, setFrecuencia] = useState<FrecuenciaRecurrencia>('MENSUAL');
  const [intervaloDias, setIntervaloDias] = useState('15');
  const [fechaInicioRegla, setFechaInicioRegla] = useState(hoyLima());
  const [cuentaReglaId, setCuentaReglaId] = useState('');
  const [categoriaReglaId, setCategoriaReglaId] = useState('');
  const [eventoReglaId, setEventoReglaId] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const cuentasActivas = instantanea.cuentas.filter((c) => c.estado === 'ACTIVO');
  const categoriasActivas = instantanea.categorias.filter(
    (c) => c.estado === 'ACTIVO' && c.padreId === null && c.naturaleza === tipoRegla,
  );
  const eventosActivos = instantanea.eventos.filter((e) => e.estado === 'ACTIVO');
  const reglasActivas = instantanea.reglasRecurrencia.filter((r) => r.estado === 'ACTIVO');

  const desdeMes = inicioDeMes(`${periodoMes}-01`);
  const hastaMes = finDeMes(`${periodoMes}-01`);

  const agendaMes = useMemo(
    () =>
      construirAgendaCalendario({
        desde: desdeMes,
        hasta: hastaMes,
        eventos: instantanea.eventos,
        gastosPlanificados: instantanea.gastosPlanificados,
        reglasRecurrencia: reglasActivas,
      }),
    [desdeMes, hastaMes, instantanea.eventos, instantanea.gastosPlanificados, reglasActivas],
  );

  const ocurrenciasPendientesMes = useMemo(() => {
    const lista = [];
    for (const r of reglasActivas) {
      const ocs = proyectarOcurrenciasRegla(r, desdeMes, hastaMes);
      lista.push(...ocs);
    }
    return lista.sort((a, b) => a.fechaProgramada.localeCompare(b.fechaProgramada));
  }, [reglasActivas, desdeMes, hastaMes]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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

      {/* 1. Calendario unificado del mes */}
      <section className="card">
        <div className="card-title">
          <span>
            Calendario Financiero ({periodoMes}): Viajes, Eventos, Compromisos y Fechas de Pago
          </span>
          <span className="badge badge-origen">PROYECTADO / DERIVADO</span>
        </div>

        {agendaMes.length === 0 ? (
          <div className="estado-vacio">
            No hay eventos, gastos planificados ni vencimientos recurrentes programados en {periodoMes}.
          </div>
        ) : (
          <div className="lista-movimientos">
            {agendaMes.map((h) => (
              <div key={h.id} className="item-movimiento">
                <div>
                  <span className="badge badge-origen">{h.origen}</span>{' '}
                  <span className="badge badge-transferencia">{h.tipoHito}</span>{' '}
                  <strong>{h.titulo}</strong>
                  <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: '4px' }}>
                    Fecha: <strong>{h.fecha}</strong> · {h.subtitulo}
                  </div>
                </div>
                {h.montoCentimos !== null && (
                  <strong>{formatearMonto(h.montoCentimos, 'PEN')}</strong>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Ocurrencias proyectadas de reglas recurrentes (requieren autorización explícita) */}
      <section className="card">
        <div className="card-title">
          <span>Previsiones recurrentes en {periodoMes} (No se registran sin tu autorización)</span>
          <span className="badge badge-origen">PROYECTADO</span>
        </div>

        {ocurrenciasPendientesMes.length === 0 ? (
          <div className="estado-vacio">
            No hay ocurrencias recurrentes proyectadas para {periodoMes}.
          </div>
        ) : (
          <div className="lista-movimientos">
            {ocurrenciasPendientesMes.map((oc) => (
              <div key={`${oc.reglaId}-${oc.fechaProgramada}`} className="item-movimiento">
                <div>
                  <span className="badge badge-origen">PROYECTADO</span>{' '}
                  <strong>{oc.nombreRegla}</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '4px' }}>
                    Fecha prevista: <strong>{oc.fechaProgramada}</strong> · Estado:{' '}
                    {oc.estadoOcurrencia}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <strong>{formatearMonto(oc.montoEstimadoCentimos, 'PEN')}</strong>
                  {oc.estadoOcurrencia === 'PENDIENTE_AUTORIZACION' && (
                    <button
                      type="button"
                      className="btn btn-primario"
                      style={{ minHeight: '34px', padding: '4px 10px', fontSize: '0.78rem' }}
                      onClick={async () => {
                        setError(null);
                        try {
                          await repositorio.autorizarOcurrenciaRecurrente({
                            reglaId: oc.reglaId,
                            fechaProgramada: oc.fechaProgramada,
                          });
                          await onRecargar();
                          setMensaje(
                            `Compromiso "${oc.nombreRegla}" (${oc.fechaProgramada}) autorizado y registrado como movimiento real.`,
                          );
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Autorizar y registrar pago real
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Crear nueva regla de recurrencia */}
      <section className="card">
        <h4 className="card-title">
          Crear regla de recurrencia (semanal, mensual, anual o personalizada)
        </h4>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const centimos = parsearMonto(montoReglaTexto, 'PEN');
              await repositorio.crearReglaRecurrencia({
                nombre: nombreRegla,
                tipo: tipoRegla,
                montoEstimadoCentimos: centimos,
                frecuencia,
                intervaloDias:
                  frecuencia === 'PERSONALIZADA_DIAS' ? Number(intervaloDias) : null,
                fechaInicio: fechaInicioRegla,
                cuentaId: cuentaReglaId,
                categoriaId: categoriaReglaId,
                eventoId: eventoReglaId || null,
              });
              setNombreRegla('');
              setMontoReglaTexto('');
              await onRecargar();
              setMensaje('Regla de recurrencia guardada como previsión.');
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
            placeholder="Nombre (ej. Alquiler, Internet, Seguro...)"
            value={nombreRegla}
            onChange={(e) => setNombreRegla(e.target.value)}
          />
          <select
            className="input-control"
            value={tipoRegla}
            onChange={(e) => {
              setTipoRegla(e.target.value as 'GASTO' | 'INGRESO');
              setCategoriaReglaId('');
            }}
          >
            <option value="GASTO">Gasto recurrente</option>
            <option value="INGRESO">Ingreso recurrente</option>
          </select>
          <input
            type="text"
            inputMode="decimal"
            required
            className="input-control"
            placeholder="Monto estimado S/"
            value={montoReglaTexto}
            onChange={(e) => setMontoReglaTexto(e.target.value)}
          />
          <select
            className="input-control"
            value={frecuencia}
            onChange={(e) => setFrecuencia(e.target.value as FrecuenciaRecurrencia)}
          >
            {FRECUENCIAS_RECURRENCIA.map((f) => (
              <option key={f} value={f}>
                Frecuencia: {f}
              </option>
            ))}
          </select>
          {frecuencia === 'PERSONALIZADA_DIAS' && (
            <input
              type="number"
              min="1"
              required
              className="input-control"
              placeholder="Cada cuántos días"
              value={intervaloDias}
              onChange={(e) => setIntervaloDias(e.target.value)}
            />
          )}
          <input
            type="date"
            required
            className="input-control"
            value={fechaInicioRegla}
            onChange={(e) => setFechaInicioRegla(e.target.value)}
          />
          <select
            required
            className="input-control"
            value={cuentaReglaId}
            onChange={(e) => setCuentaReglaId(e.target.value)}
          >
            <option value="">Cuenta prevista...</option>
            {cuentasActivas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          <select
            required
            className="input-control"
            value={categoriaReglaId}
            onChange={(e) => setCategoriaReglaId(e.target.value)}
          >
            <option value="">Categoría prevista...</option>
            {categoriasActivas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          <select
            className="input-control"
            value={eventoReglaId}
            onChange={(e) => setEventoReglaId(e.target.value)}
          >
            <option value="">Sin evento asociado</option>
            {eventosActivos.map((ev) => (
              <option key={ev.id} value={ev.id}>
                Evento: {ev.nombre}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primario">
            Guardar regla recurrente
          </button>
        </form>
      </section>
    </div>
  );
};
