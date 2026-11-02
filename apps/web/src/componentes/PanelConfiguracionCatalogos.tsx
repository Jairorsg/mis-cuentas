import React, { useState } from 'react';
import {
  aTextoDecimal,
  formatearMonto,
  hoyLima,
  parsearMonto,
  type SaldoCuentaCalculado,
  TIPOS_METODO_CUENTA,
  type TipoMetodoCuenta,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio, RepositorioFinanciero } from '../persistencia/puerto';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  saldosPorCuenta: readonly SaldoCuentaCalculado[];
  periodoMes: string;
  repositorio: RepositorioFinanciero;
  onRecargar: () => Promise<void>;
}

export const PanelConfiguracionCatalogos: React.FC<Props> = ({
  instantanea,
  saldosPorCuenta,
  periodoMes,
  repositorio,
  onRecargar,
}) => {
  // Nueva cuenta / método
  const [nombreCuenta, setNombreCuenta] = useState('');
  const [tipoCuenta, setTipoCuenta] = useState<TipoMetodoCuenta>('EFECTIVO');
  const [saldoInicialTexto, setSaldoInicialTexto] = useState('');
  const [fechaSaldoInicial, setFechaSaldoInicial] = useState(hoyLima());

  // Edición de saldo inicial real en cuenta existente
  const [cuentaParaSaldoId, setCuentaParaSaldoId] = useState('');
  const [montoSaldoExistente, setMontoSaldoExistente] = useState('');
  const [fechaSaldoExistente, setFechaSaldoExistente] = useState(hoyLima());

  // Nueva categoría o subcategoría
  const [nombreCat, setNombreCat] = useState('');
  const [naturalezaCat, setNaturalezaCat] = useState<'GASTO' | 'INGRESO'>('GASTO');
  const [padreCatId, setPadreCatId] = useState('');

  // Nuevo presupuesto mensual
  const [catPresupuestoId, setCatPresupuestoId] = useState('');
  const [limitePresupuestoTexto, setLimitePresupuestoTexto] = useState('');

  // Nuevo evento financiero (independiente y reutilizable)
  const [nombreEvento, setNombreEvento] = useState('');
  const [fechaInicioEv, setFechaInicioEv] = useState(hoyLima());
  const [presupuestoEvTexto, setPresupuestoEvTexto] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const cuentasActivas = instantanea.cuentas.filter((c) => c.estado === 'ACTIVO');
  const categoriasActivas = instantanea.categorias.filter((c) => c.estado === 'ACTIVO');
  const categoriasPrincipales = categoriasActivas.filter((c) => c.padreId === null);
  const eventosActivos = instantanea.eventos.filter((e) => e.estado === 'ACTIVO');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
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

      {/* 1. Cuentas, métodos de pago y saldos iniciales reales */}
      <section className="card">
        <div className="card-title">
          <span>Cuentas y métodos de pago (Efectivo, Yape, Plin, Débito, Crédito...)</span>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setError(null);
              const creadas = await repositorio.activarMetodosInicialesSugeridos();
              await onRecargar();
              setMensaje(
                creadas.length > 0
                  ? `Se habilitaron ${creadas.length} métodos estándar sin saldos ficticios.`
                  : 'Los métodos estándar ya estaban activos.',
              );
            }}
          >
            Activar métodos iniciales sugeridos
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {saldosPorCuenta.map((s) => (
            <div key={s.cuentaId} className="kpi-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{s.nombreCuenta}</strong>
                <span className="badge badge-origen">{s.tipoCuenta}</span>
              </div>
              <div style={{ marginTop: '6px', fontSize: '0.88rem' }}>
                {s.saldoBancarioRealCentimos !== null ? (
                  <>
                    <div>
                      Saldo bancario real:{' '}
                      <strong>{formatearMonto(s.saldoBancarioRealCentimos, 'PEN')}</strong>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                      Saldo inicial: {formatearMonto(s.saldoInicialCentimos ?? 0, 'PEN')} ({s.fechaSaldoInicial})
                    </div>
                  </>
                ) : (
                  <div className="aviso-insuficiente" style={{ marginTop: '6px', padding: '8px' }}>
                    {s.advertencia}
                    <div style={{ marginTop: '4px', fontWeight: 700 }}>
                      Flujo de movimientos: {formatearMonto(s.flujoMovimientosCentimos, 'PEN')}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn"
                style={{ marginTop: '8px', width: '100%', minHeight: '36px', fontSize: '0.82rem' }}
                onClick={() => {
                  setCuentaParaSaldoId(s.cuentaId);
                  setMontoSaldoExistente(
                    s.saldoInicialCentimos !== null ? aTextoDecimal(s.saldoInicialCentimos, 'PEN') : '',
                  );
                  setFechaSaldoExistente(s.fechaSaldoInicial ?? hoyLima());
                }}
              >
                {s.tieneSaldoInicial ? 'Editar saldo inicial real' : 'Registrar saldo inicial real'}
              </button>
            </div>
          ))}
        </div>

        {cuentaParaSaldoId && (
          <form
            style={{ padding: '12px', background: '#f8fafc', borderRadius: '10px', border: '1px solid #cbd5e1', marginBottom: '16px' }}
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const centimos = parsearMonto(montoSaldoExistente, 'PEN');
                await repositorio.registrarOActualizarSaldoInicial({
                  cuentaId: cuentaParaSaldoId,
                  saldoInicialCentimos: centimos,
                  fechaSaldoInicial: fechaSaldoExistente,
                });
                setCuentaParaSaldoId('');
                await onRecargar();
                setMensaje('Saldo inicial real registrado correctamente.');
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <h4 style={{ margin: '0 0 10px 0' }}>
              Registrar saldo inicial real —{' '}
              {cuentasActivas.find((c) => c.id === cuentaParaSaldoId)?.nombre}
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
              <input
                type="text"
                inputMode="decimal"
                required
                className="input-control"
                placeholder="Monto real en S/ (ej. 1250.00)"
                value={montoSaldoExistente}
                onChange={(e) => setMontoSaldoExistente(e.target.value)}
              />
              <input
                type="date"
                required
                className="input-control"
                value={fechaSaldoExistente}
                onChange={(e) => setFechaSaldoExistente(e.target.value)}
              />
              <button type="submit" className="btn btn-primario">
                Guardar saldo inicial
              </button>
              <button type="button" className="btn" onClick={() => setCuentaParaSaldoId('')}>
                Cancelar
              </button>
            </div>
          </form>
        )}

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const saldoIni = saldoInicialTexto.trim()
                ? parsearMonto(saldoInicialTexto, 'PEN')
                : null;
              await repositorio.crearCuenta({
                nombre: nombreCuenta,
                tipo: tipoCuenta,
                saldoInicialCentimos: saldoIni,
                fechaSaldoInicial: saldoIni !== null ? fechaSaldoInicial : undefined,
              });
              setNombreCuenta('');
              setSaldoInicialTexto('');
              await onRecargar();
              setMensaje('Cuenta o método de pago creado.');
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
            placeholder="Nombre (ej. BCP Soles, Yape...)"
            value={nombreCuenta}
            onChange={(e) => setNombreCuenta(e.target.value)}
          />
          <select
            className="input-control"
            value={tipoCuenta}
            onChange={(e) => setTipoCuenta(e.target.value as TipoMetodoCuenta)}
          >
            {TIPOS_METODO_CUENTA.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            className="input-control"
            placeholder="Saldo inicial real S/ (opcional)"
            value={saldoInicialTexto}
            onChange={(e) => setSaldoInicialTexto(e.target.value)}
          />
          <input
            type="date"
            className="input-control"
            value={fechaSaldoInicial}
            onChange={(e) => setFechaSaldoInicial(e.target.value)}
          />
          <button type="submit" className="btn btn-primario">
            Agregar método / cuenta
          </button>
        </form>
      </section>

      {/* 2. Categorías y subcategorías personalizadas */}
      <section className="card">
        <div className="card-title">
          <span>Categorías y subcategorías personalizadas</span>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setError(null);
              const creadas = await repositorio.activarCategoriasInicialesSugeridas();
              await onRecargar();
              setMensaje(`Se habilitaron ${creadas.length} categorías/subcategorías sugeridas.`);
            }}
          >
            Activar categorías sugeridas
          </button>
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const padre = categoriasPrincipales.find((c) => c.id === padreCatId);
              await repositorio.crearCategoria({
                nombre: nombreCat,
                naturaleza: padre ? padre.naturaleza : naturalezaCat,
                padreId: padreCatId || null,
              });
              setNombreCat('');
              await onRecargar();
              setMensaje('Categoría guardada.');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '12px' }}
        >
          <input
            type="text"
            required
            className="input-control"
            placeholder="Nombre de categoría o subcategoría"
            value={nombreCat}
            onChange={(e) => setNombreCat(e.target.value)}
          />
          <select
            className="input-control"
            value={naturalezaCat}
            disabled={Boolean(padreCatId)}
            onChange={(e) => setNaturalezaCat(e.target.value as 'GASTO' | 'INGRESO')}
          >
            <option value="GASTO">Egreso (Gasto)</option>
            <option value="INGRESO">Ingreso</option>
          </select>
          <select
            className="input-control"
            value={padreCatId}
            onChange={(e) => setPadreCatId(e.target.value)}
          >
            <option value="">Categoría principal (raíz)</option>
            {categoriasPrincipales.map((c) => (
              <option key={c.id} value={c.id}>
                Subcategoría de: {c.nombre} ({c.naturaleza})
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primario">
            Crear categoría
          </button>
        </form>

        <div className="chip-group">
          {categoriasPrincipales.map((cat) => {
            const subs = categoriasActivas.filter((s) => s.padreId === cat.id);
            return (
              <div key={cat.id} className="kpi-box" style={{ minWidth: '210px' }}>
                <strong>
                  {cat.nombre} ({cat.naturaleza})
                </strong>
                {subs.length > 0 && (
                  <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: '4px' }}>
                    Subcategorías: {subs.map((s) => s.nombre).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 3. Presupuestos del periodo */}
      <section className="card">
        <h3 className="card-title">Presupuestos mensuales ({periodoMes})</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const centimos = parsearMonto(limitePresupuestoTexto, 'PEN');
              await repositorio.guardarPresupuesto({
                periodoMes,
                categoriaId: catPresupuestoId,
                limiteCentimos: centimos,
              });
              setLimitePresupuestoTexto('');
              await onRecargar();
              setMensaje('Presupuesto guardado.');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}
        >
          <select
            required
            className="input-control"
            value={catPresupuestoId}
            onChange={(e) => setCatPresupuestoId(e.target.value)}
          >
            <option value="">Selecciona categoría de gasto...</option>
            {categoriasPrincipales
              .filter((c) => c.naturaleza === 'GASTO')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            required
            className="input-control"
            placeholder="Límite mensual S/ (ej. 600.00)"
            value={limitePresupuestoTexto}
            onChange={(e) => setLimitePresupuestoTexto(e.target.value)}
          />
          <button type="submit" className="btn btn-primario">
            Guardar presupuesto
          </button>
        </form>
      </section>

      {/* 4. Eventos independientes e ilimitados */}
      <section className="card">
        <h3 className="card-title">Eventos independientes (viajes, proyectos, celebraciones...)</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const pres = presupuestoEvTexto.trim()
                ? parsearMonto(presupuestoEvTexto, 'PEN')
                : null;
              await repositorio.crearEvento({
                nombre: nombreEvento,
                fechaInicio: fechaInicioEv,
                presupuestoCentimos: pres,
              });
              setNombreEvento('');
              setPresupuestoEvTexto('');
              await onRecargar();
              setMensaje('Evento creado.');
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '12px' }}
        >
          <input
            type="text"
            required
            className="input-control"
            placeholder="Nombre del evento (cualquier viaje o proyecto)"
            value={nombreEvento}
            onChange={(e) => setNombreEvento(e.target.value)}
          />
          <input
            type="date"
            required
            className="input-control"
            value={fechaInicioEv}
            onChange={(e) => setFechaInicioEv(e.target.value)}
          />
          <input
            type="text"
            inputMode="decimal"
            className="input-control"
            placeholder="Presupuesto opcional S/"
            value={presupuestoEvTexto}
            onChange={(e) => setPresupuestoEvTexto(e.target.value)}
          />
          <button type="submit" className="btn btn-primario">
            Crear evento
          </button>
        </form>

        {eventosActivos.length > 0 && (
          <div className="chip-group">
            {eventosActivos.map((ev) => (
              <div key={ev.id} className="kpi-box" style={{ minWidth: '220px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <strong>{ev.nombre}</strong>
                  <span className="badge badge-origen">{ev.estadoEvento}</span>
                </div>
                <div style={{ fontSize: '0.8rem', color: '#475569', marginTop: '4px' }}>
                  Desde {ev.fechaInicio}{' '}
                  {ev.presupuestoTotalCentimos > 0 && `· Meta: ${formatearMonto(ev.presupuestoTotalCentimos, 'PEN')}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
