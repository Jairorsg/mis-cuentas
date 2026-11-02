import React, { useEffect, useMemo, useState } from 'react';
import {
  aTextoDecimal,
  type CategoriaPersonalizada,
  type CuentaMetodo,
  type EventoFinanciero,
  hoyLima,
  type MovimientoFinanciero,
  parsearMonto,
  parsearTextoEtiquetas,
  type TipoMovimiento,
} from '@mis-cuentas/core';
import type { EntradaActualizarMovimiento, EntradaCrearMovimiento } from '../persistencia/puerto';

interface Props {
  cuentasActivas: readonly CuentaMetodo[];
  categoriasActivas: readonly CategoriaPersonalizada[];
  eventosActivos: readonly EventoFinanciero[];
  etiquetasConocidas: readonly string[];
  movimientoEditar?: MovimientoFinanciero | null;
  onGuardarNuevo: (entrada: EntradaCrearMovimiento) => Promise<void>;
  onGuardarEdicion: (entrada: EntradaActualizarMovimiento) => Promise<void>;
  onActivarCatalogosRapidos: () => Promise<void>;
  onCerrar: () => void;
}

function horaActualLima(): string {
  const ahora = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partes = fmt.formatToParts(ahora);
  const h = partes.find((p) => p.type === 'hour')?.value ?? '12';
  const m = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

export const FormularioMovimientoRapido: React.FC<Props> = ({
  cuentasActivas,
  categoriasActivas,
  eventosActivos,
  etiquetasConocidas,
  movimientoEditar,
  onGuardarNuevo,
  onGuardarEdicion,
  onActivarCatalogosRapidos,
  onCerrar,
}) => {
  const [tipo, setTipo] = useState<TipoMovimiento>(movimientoEditar?.tipo ?? 'GASTO');
  const [montoTexto, setMontoTexto] = useState<string>(
    movimientoEditar ? aTextoDecimal(movimientoEditar.montoCentimos, 'PEN') : '',
  );
  const [cuentaId, setCuentaId] = useState<string>(
    movimientoEditar?.cuentaId ?? cuentasActivas[0]?.id ?? '',
  );
  const [cuentaDestinoId, setCuentaDestinoId] = useState<string>(
    movimientoEditar?.cuentaDestinoId ?? cuentasActivas[1]?.id ?? '',
  );

  const categoriasPrincipales = useMemo(
    () =>
      categoriasActivas.filter(
        (c) => c.padreId === null && (tipo === 'INGRESO' ? c.naturaleza === 'INGRESO' : c.naturaleza === 'GASTO'),
      ),
    [categoriasActivas, tipo],
  );

  const [categoriaId, setCategoriaId] = useState<string>(
    movimientoEditar?.categoriaId ?? categoriasPrincipales[0]?.id ?? '',
  );
  const [subcategoriaId, setSubcategoriaId] = useState<string>(movimientoEditar?.subcategoriaId ?? '');

  const subcategoriasDisponibles = useMemo(
    () => categoriasActivas.filter((c) => c.padreId === categoriaId),
    [categoriasActivas, categoriaId],
  );

  const [fechaMovimiento, setFechaMovimiento] = useState<string>(
    movimientoEditar?.fechaMovimiento ?? hoyLima(),
  );
  const [horaMovimiento, setHoraMovimiento] = useState<string>(
    movimientoEditar?.horaMovimiento ?? horaActualLima(),
  );
  const [descripcion, setDescripcion] = useState<string>(movimientoEditar?.descripcion ?? '');
  const [etiquetasTexto, setEtiquetasTexto] = useState<string>(
    movimientoEditar?.etiquetas.join(' ') ?? '',
  );
  const [eventoId, setEventoId] = useState<string>(movimientoEditar?.eventoId ?? '');
  const [mostrarOpcionesAvanzadas, setMostrarOpcionesAvanzadas] = useState<boolean>(
    Boolean(movimientoEditar),
  );
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState<boolean>(false);

  useEffect(() => {
    if (!cuentaId && cuentasActivas.length > 0) {
      setCuentaId(cuentasActivas[0]!.id);
    }
  }, [cuentasActivas, cuentaId]);

  useEffect(() => {
    if (tipo === 'INGRESO' || tipo === 'GASTO') {
      const existeEnTipo = categoriasPrincipales.some((c) => c.id === categoriaId);
      if (!existeEnTipo) {
        setCategoriaId(categoriasPrincipales[0]?.id ?? '');
        setSubcategoriaId('');
      }
    }
  }, [tipo, categoriasPrincipales, categoriaId]);

  const cuentaDestinoObj = cuentasActivas.find((c) => c.id === cuentaDestinoId);
  const esPagoTarjetaDetectado =
    tipo === 'TRANSFERENCIA' && cuentaDestinoObj?.tipo === 'TARJETA_CREDITO';

  const alternarEtiquetaRapida = (tag: string) => {
    const actuales = parsearTextoEtiquetas(etiquetasTexto);
    const yaEsta = actuales.some((t) => t.toLowerCase() === tag.toLowerCase());
    const nuevas = yaEsta
      ? actuales.filter((t) => t.toLowerCase() !== tag.toLowerCase())
      : [...actuales, tag];
    setEtiquetasTexto(nuevas.join(' '));
  };

  const manejarSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setGuardando(true);
    try {
      const montoCentimos = parsearMonto(montoTexto, 'PEN');
      const etiquetas = parsearTextoEtiquetas(etiquetasTexto);

      if (movimientoEditar) {
        await onGuardarEdicion({
          id: movimientoEditar.id,
          tipo,
          montoCentimos,
          cuentaId,
          cuentaDestinoId: tipo === 'TRANSFERENCIA' ? cuentaDestinoId : null,
          categoriaId: tipo === 'INGRESO' || tipo === 'GASTO' ? categoriaId : null,
          subcategoriaId:
            (tipo === 'INGRESO' || tipo === 'GASTO') && subcategoriaId ? subcategoriaId : null,
          fechaMovimiento,
          horaMovimiento,
          descripcion: descripcion.trim() || null,
          etiquetas,
          eventoId: eventoId || null,
          esPagoTarjeta: esPagoTarjetaDetectado,
        });
      } else {
        await onGuardarNuevo({
          tipo,
          montoCentimos,
          cuentaId,
          cuentaDestinoId: tipo === 'TRANSFERENCIA' ? cuentaDestinoId : null,
          categoriaId: tipo === 'INGRESO' || tipo === 'GASTO' ? categoriaId : null,
          subcategoriaId:
            (tipo === 'INGRESO' || tipo === 'GASTO') && subcategoriaId ? subcategoriaId : null,
          fechaMovimiento,
          horaMovimiento,
          descripcion: descripcion.trim() || null,
          etiquetas,
          eventoId: eventoId || null,
          esPagoTarjeta: esPagoTarjetaDetectado,
          origen: 'MANUAL',
        });
      }
      onCerrar();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGuardando(false);
    }
  };

  if (cuentasActivas.length === 0 || categoriasActivas.length === 0) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Configurar catálogos antes de registrar">
        <div className="modal-sheet">
          <h3 className="card-title">Configura tus métodos y categorías</h3>
          <p style={{ color: '#475569', fontSize: '0.92rem' }}>
            La base de datos está vacía (sin datos ficticios). Puedes activar en un toque los métodos de pago
            estándar (Efectivo, Yape, Plin, Tarjeta de débito, Tarjeta de crédito) y las categorías base, todas con
            saldo cero, para registrar tu primer movimiento real de inmediato.
          </p>
          {error && <div className="aviso-insuficiente" role="alert">{error}</div>}
          <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
            <button
              type="button"
              className="btn btn-primario"
              style={{ flex: 1 }}
              onClick={async () => {
                try {
                  setGuardando(true);
                  await onActivarCatalogosRapidos();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setGuardando(false);
                }
              }}
              disabled={guardando}
            >
              {guardando ? 'Activando...' : 'Activar métodos y categorías base'}
            </button>
            <button type="button" className="btn" onClick={onCerrar}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  const sugerenciasEtiquetas = Array.from(
    new Set(['#Rutina', '#ViajeTacna', '#Trabajo', '#Hogar', ...etiquetasConocidas]),
  );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Registrar movimiento financiero">
      <form className="modal-sheet" onSubmit={manejarSubmit}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem' }}>
            {movimientoEditar ? 'Editar movimiento' : 'Registro rápido (S/)'}
          </h3>
          <button type="button" className="btn" onClick={onCerrar} aria-label="Cerrar formulario">
            Cerrar
          </button>
        </div>

        {/* Selector táctil de Tipo de operación */}
        <div className="chip-group" style={{ marginBottom: '12px' }} role="radiogroup" aria-label="Tipo de movimiento">
          {(
            [
              { id: 'GASTO', label: 'Egreso (-)' },
              { id: 'INGRESO', label: 'Ingreso (+)' },
              { id: 'TRANSFERENCIA', label: 'Transferencia / Pago TC' },
            ] as const
          ).map((op) => (
            <button
              key={op.id}
              type="button"
              className={`chip-btn ${tipo === op.id ? 'seleccionado' : ''}`}
              style={{ flex: 1 }}
              onClick={() => setTipo(op.id)}
            >
              {op.label}
            </button>
          ))}
        </div>

        {/* Monto con teclado numérico directo en celular */}
        <div className="campo-form">
          <label htmlFor="input-monto-pen">Monto en Soles (PEN S/)</label>
          <input
            id="input-monto-pen"
            type="text"
            inputMode="decimal"
            autoFocus
            required
            placeholder="0.00"
            className="input-control input-monto-rapido"
            value={montoTexto}
            onChange={(e) => setMontoTexto(e.target.value)}
          />
        </div>

        {/* Selección de un toque de Cuenta / Método de pago */}
        <div className="campo-form">
          <label>{tipo === 'TRANSFERENCIA' ? 'Desde cuenta / método origen' : 'Cuenta o método de pago'}</label>
          <div className="chip-group">
            {cuentasActivas.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chip-btn ${cuentaId === c.id ? 'seleccionado' : ''}`}
                onClick={() => setCuentaId(c.id)}
              >
                {c.nombre}
              </button>
            ))}
          </div>
        </div>

        {tipo === 'TRANSFERENCIA' ? (
          <div className="campo-form">
            <label>Hacia cuenta / método destino</label>
            <div className="chip-group">
              {cuentasActivas
                .filter((c) => c.id !== cuentaId)
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip-btn ${cuentaDestinoId === c.id ? 'seleccionado' : ''}`}
                    onClick={() => setCuentaDestinoId(c.id)}
                  >
                    {c.nombre}
                  </button>
                ))}
            </div>
            {esPagoTarjetaDetectado && (
              <div className="aviso-insuficiente" style={{ marginTop: '8px', background: '#e0f2fe', color: '#0369a1', borderColor: '#bae6fd' }}>
                Pago de tarjeta de crédito detectado: esta transferencia reduce la deuda de tu tarjeta sin volver a sumar un gasto (evita doble contabilización).
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="campo-form">
              <label>Categoría</label>
              <div className="chip-group">
                {categoriasPrincipales.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className={`chip-btn ${categoriaId === cat.id ? 'seleccionado' : ''}`}
                    onClick={() => {
                      setCategoriaId(cat.id);
                      setSubcategoriaId('');
                    }}
                  >
                    {cat.nombre}
                  </button>
                ))}
              </div>
            </div>

            {subcategoriasDisponibles.length > 0 && (
              <div className="campo-form">
                <label>Subcategoría (opcional)</label>
                <div className="chip-group">
                  <button
                    type="button"
                    className={`chip-btn ${subcategoriaId === '' ? 'seleccionado' : ''}`}
                    onClick={() => setSubcategoriaId('')}
                  >
                    General
                  </button>
                  {subcategoriasDisponibles.map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      className={`chip-btn ${subcategoriaId === sub.id ? 'seleccionado' : ''}`}
                      onClick={() => setSubcategoriaId(sub.id)}
                    >
                      {sub.nombre}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Etiquetas rápidas + entrada libre */}
        <div className="campo-form">
          <label htmlFor="input-etiquetas">Etiquetas (ej. #Rutina #ViajeTacna)</label>
          <div className="chip-group" style={{ marginBottom: '6px' }}>
            {sugerenciasEtiquetas.map((tag) => {
              const activa = parsearTextoEtiquetas(etiquetasTexto).some(
                (t) => t.toLowerCase() === tag.toLowerCase(),
              );
              return (
                <button
                  key={tag}
                  type="button"
                  className={`chip-btn ${activa ? 'seleccionado' : ''}`}
                  onClick={() => alternarEtiquetaRapida(tag)}
                >
                  {tag}
                </button>
              );
            })}
          </div>
          <input
            id="input-etiquetas"
            type="text"
            className="input-control"
            placeholder="Escribe etiquetas libres separadas por espacio..."
            value={etiquetasTexto}
            onChange={(e) => setEtiquetasTexto(e.target.value)}
          />
        </div>

        <div className="campo-form">
          <label htmlFor="input-descripcion">Descripción (opcional)</label>
          <input
            id="input-descripcion"
            type="text"
            className="input-control"
            placeholder="Detalle breve..."
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
          />
        </div>

        <button
          type="button"
          className="btn"
          style={{ width: '100%', marginBottom: '12px' }}
          onClick={() => setMostrarOpcionesAvanzadas((v) => !v)}
        >
          {mostrarOpcionesAvanzadas
            ? 'Ocultar fecha, hora y evento'
            : `Fecha (${fechaMovimiento} ${horaMovimiento}) y Evento opcional`}
        </button>

        {mostrarOpcionesAvanzadas && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div className="campo-form" style={{ marginBottom: 0 }}>
              <label htmlFor="input-fecha-mov">Fecha del movimiento (Lima)</label>
              <input
                id="input-fecha-mov"
                type="date"
                className="input-control"
                value={fechaMovimiento}
                onChange={(e) => setFechaMovimiento(e.target.value)}
              />
            </div>
            <div className="campo-form" style={{ marginBottom: 0 }}>
              <label htmlFor="input-hora-mov">Hora</label>
              <input
                id="input-hora-mov"
                type="time"
                className="input-control"
                value={horaMovimiento}
                onChange={(e) => setHoraMovimiento(e.target.value)}
              />
            </div>
            <div className="campo-form" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
              <label htmlFor="select-evento">Evento asociado (opcional)</label>
              <select
                id="select-evento"
                className="input-control"
                value={eventoId}
                onChange={(e) => setEventoId(e.target.value)}
              >
                <option value="">Sin evento asociado</option>
                {eventosActivos.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.nombre} ({ev.estadoEvento})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {error && (
          <div className="aviso-insuficiente" role="alert" style={{ marginBottom: '12px' }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn btn-primario" style={{ width: '100%', fontSize: '1.05rem' }} disabled={guardando}>
          {guardando ? 'Guardando...' : movimientoEditar ? 'Guardar cambios' : 'Guardar movimiento'}
        </button>
      </form>
    </div>
  );
};
