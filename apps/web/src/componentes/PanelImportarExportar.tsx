import React, { useState } from 'react';
import {
  exportarLibroAJson,
  exportarMovimientosACsv,
  formatearMonto,
  previsualizarImportacionCsv,
  previsualizarImportacionJson,
  type ResultadoPrevisualizacionImportacion,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio, RepositorioFinanciero } from '../persistencia/puerto';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  repositorio: RepositorioFinanciero;
  onRecargar: () => Promise<void>;
}

function descargarArchivoTexto(nombreArchivo: string, contenido: string, mime: string): void {
  const blob = new Blob([contenido], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const PanelImportarExportar: React.FC<Props> = ({ instantanea, repositorio, onRecargar }) => {
  const [formatoImportar, setFormatoImportar] = useState<'CSV' | 'JSON'>('CSV');
  const [textoEntrada, setTextoEntrada] = useState<string>('');
  const [previsualizacion, setPrevisualizacion] = useState<ResultadoPrevisualizacionImportacion | null>(null);
  const [politicaDuplicados, setPoliticaDuplicados] = useState<'OMITIR' | 'SOBRESCRIBIR'>('OMITIR');
  const [confirmarSobrescritura, setConfirmarSobrescritura] = useState<boolean>(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manejarSeleccionArchivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    if (!archivo) return;
    const texto = await archivo.text();
    setTextoEntrada(texto);
    if (archivo.name.toLowerCase().endsWith('.json')) {
      setFormatoImportar('JSON');
    } else {
      setFormatoImportar('CSV');
    }
    setPrevisualizacion(null);
    setMensaje(null);
    setError(null);
  };

  const ejecutarPrevisualizacion = () => {
    setError(null);
    setMensaje(null);
    const loteId = `lote-${Date.now()}`;
    if (formatoImportar === 'CSV') {
      const prev = previsualizarImportacionCsv({
        contenidoCsv: textoEntrada,
        cuentasExistentes: instantanea.cuentas,
        categoriasExistentes: instantanea.categorias,
        eventosExistentes: instantanea.eventos,
        movimientosExistentes: instantanea.movimientos,
        loteImportacionId: loteId,
      });
      setPrevisualizacion(prev);
    } else {
      const prev = previsualizarImportacionJson({
        contenidoJson: textoEntrada,
        movimientosExistentes: instantanea.movimientos,
        loteImportacionId: loteId,
      });
      setPrevisualizacion(prev);
    }
  };

  const confirmarImportacion = async () => {
    if (!previsualizacion) return;
    setError(null);
    setMensaje(null);
    if (
      previsualizacion.duplicadosDetectados > 0 &&
      politicaDuplicados === 'SOBRESCRIBIR' &&
      !confirmarSobrescritura
    ) {
      setError('Debes marcar la casilla de confirmación antes de sobrescribir registros duplicados.');
      return;
    }
    try {
      const res = await repositorio.ejecutarImportacionTransaccional({
        loteId: `lote-${Date.now()}`,
        filasPrevisualizadas: previsualizacion.filas,
        politicaDuplicados,
        cuentasIncluidas: previsualizacion.cuentasIncluidas,
        categoriasIncluidas: previsualizacion.categoriasIncluidas,
        eventosIncluidos: previsualizacion.eventosIncluidos,
        presupuestosIncluidos: previsualizacion.presupuestosIncluidos,
        gastosPlanificadosIncluidos: previsualizacion.gastosPlanificadosIncluidos,
        gastosCompartidosIncluidos: previsualizacion.gastosCompartidosIncluidos,
        liquidacionesCompartidasIncluidas: previsualizacion.liquidacionesCompartidasIncluidas,
        reglasRecurrenciaIncluidas: previsualizacion.reglasRecurrenciaIncluidas,
      });
      await onRecargar();
      setPrevisualizacion(null);
      setTextoEntrada('');
      setMensaje(
        `Importación transaccional completada (Lote ${res.loteId}): ${res.insertados} nuevos, ${res.sobrescritos} sobrescritos, ${res.omitidosPorDuplicado} duplicados omitidos.`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <section className="card">
        <h3 className="card-title">Exportar información real del usuario</h3>
        <p style={{ color: '#475569', fontSize: '0.9rem', marginTop: 0 }}>
          Descarga tus movimientos y catálogos en formato CSV (compatible con hojas de cálculo) o JSON completo.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          <button
            type="button"
            className="btn btn-primario"
            onClick={() => {
              const csv = exportarMovimientosACsv({
                movimientos: instantanea.movimientos,
                cuentas: instantanea.cuentas,
                categorias: instantanea.categorias,
                eventos: instantanea.eventos,
              });
              descargarArchivoTexto('mis-cuentas-movimientos.csv', csv, 'text/csv;charset=utf-8');
            }}
          >
            Exportar movimientos (.CSV)
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const json = exportarLibroAJson({
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
              descargarArchivoTexto('mis-cuentas-respaldo.json', json, 'application/json;charset=utf-8');
            }}
          >
            Exportar respaldo completo (.JSON)
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="card-title">Importar CSV o JSON (transaccional con validación y detección de duplicados)</h3>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`chip-btn ${formatoImportar === 'CSV' ? 'seleccionado' : ''}`}
            onClick={() => {
              setFormatoImportar('CSV');
              setPrevisualizacion(null);
            }}
          >
            Formato CSV
          </button>
          <button
            type="button"
            className={`chip-btn ${formatoImportar === 'JSON' ? 'seleccionado' : ''}`}
            onClick={() => {
              setFormatoImportar('JSON');
              setPrevisualizacion(null);
            }}
          >
            Formato JSON
          </button>
          <label className="btn" style={{ cursor: 'pointer' }}>
            Cargar archivo (.csv / .json)
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              style={{ display: 'none' }}
              onChange={manejarSeleccionArchivo}
            />
          </label>
        </div>

        <div className="campo-form">
          <label htmlFor="textarea-importacion">
            Contenido a importar ({formatoImportar === 'CSV' ? 'Columnas mínimas: fechaMovimiento,tipo,cuenta,categoria,montoPEN,etiquetas,descripcion' : 'Paquete JSON mis-cuentas/libro-usuario'})
          </label>
          <textarea
            id="textarea-importacion"
            rows={5}
            className="input-control"
            style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
            value={textoEntrada}
            onChange={(e) => {
              setTextoEntrada(e.target.value);
              setPrevisualizacion(null);
            }}
            placeholder={
              formatoImportar === 'CSV'
                ? 'fechaMovimiento,tipo,cuenta,categoria,montoPEN,etiquetas,descripcion\n2026-11-01,GASTO,Yape,Alimentación,18.50,#Rutina,Menú ejecutivo'
                : '{"formato":"mis-cuentas/libro-usuario","version":1,"movimientos":[...]}'
            }
          />
        </div>

        <button
          type="button"
          className="btn btn-primario"
          onClick={ejecutarPrevisualizacion}
          disabled={!textoEntrada.trim()}
        >
          1. Validar y previsualizar registros
        </button>

        {mensaje && (
          <div style={{ marginTop: '12px', padding: '12px', background: '#dcfce7', color: '#15803d', borderRadius: '10px', fontWeight: 600 }}>
            {mensaje}
          </div>
        )}
        {error && (
          <div className="aviso-insuficiente" role="alert" style={{ marginTop: '12px' }}>
            {error}
          </div>
        )}

        {previsualizacion && (
          <div style={{ marginTop: '16px', borderTop: '1px solid #e2e8f0', paddingTop: '14px' }}>
            <h4 style={{ margin: '0 0 10px 0' }}>
              Resultado de la previsualización ({previsualizacion.formato}): {previsualizacion.validosNuevos} nuevos,{' '}
              {previsualizacion.duplicadosDetectados} duplicados, {previsualizacion.conErrores} con errores
            </h4>

            {previsualizacion.duplicadosDetectados > 0 && (
              <div className="aviso-insuficiente" style={{ marginBottom: '12px' }}>
                <strong>Se detectaron {previsualizacion.duplicadosDetectados} registro(s) duplicados.</strong>
                <div style={{ display: 'flex', gap: '10px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`chip-btn ${politicaDuplicados === 'OMITIR' ? 'seleccionado' : ''}`}
                    onClick={() => setPoliticaDuplicados('OMITIR')}
                  >
                    Omitir duplicados (conservar existentes)
                  </button>
                  <button
                    type="button"
                    className={`chip-btn ${politicaDuplicados === 'SOBRESCRIBIR' ? 'seleccionado' : ''}`}
                    onClick={() => setPoliticaDuplicados('SOBRESCRIBIR')}
                  >
                    Sobrescribir existentes
                  </button>
                </div>
                {politicaDuplicados === 'SOBRESCRIBIR' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontWeight: 700 }}>
                    <input
                      type="checkbox"
                      checked={confirmarSobrescritura}
                      onChange={(e) => setConfirmarSobrescritura(e.target.checked)}
                    />
                    Confirmo que deseo sobrescribir los registros duplicados existentes con los del archivo.
                  </label>
                )}
              </div>
            )}

            <div style={{ maxHeight: '260px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '10px', marginBottom: '12px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
                <thead>
                  <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
                    <th style={{ padding: '8px' }}>Fila</th>
                    <th style={{ padding: '8px' }}>Estado</th>
                    <th style={{ padding: '8px' }}>Fecha</th>
                    <th style={{ padding: '8px' }}>Tipo</th>
                    <th style={{ padding: '8px' }}>Monto</th>
                    <th style={{ padding: '8px' }}>Detalle / Errores</th>
                  </tr>
                </thead>
                <tbody>
                  {previsualizacion.filas.map((f) => (
                    <tr key={f.indiceFila} style={{ borderTop: '1px solid #e2e8f0' }}>
                      <td style={{ padding: '8px' }}>{f.indiceFila}</td>
                      <td style={{ padding: '8px' }}>
                        <span className="badge badge-origen">{f.estado}</span>
                      </td>
                      <td style={{ padding: '8px' }}>{f.movimientoPropuesto?.fechaMovimiento ?? '-'}</td>
                      <td style={{ padding: '8px' }}>{f.movimientoPropuesto?.tipo ?? '-'}</td>
                      <td style={{ padding: '8px' }}>
                        {f.movimientoPropuesto ? formatearMonto(f.movimientoPropuesto.montoCentimos, 'PEN') : '-'}
                      </td>
                      <td style={{ padding: '8px' }}>
                        {f.errores.length > 0 ? (
                          <span style={{ color: '#b91c1c', fontWeight: 600 }}>{f.errores.join('; ')}</span>
                        ) : (
                          f.movimientoPropuesto?.descripcion ?? 'Sin descripción'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <button
              type="button"
              className="btn btn-primario"
              disabled={previsualizacion.conErrores > 0 || previsualizacion.totalFilas === 0}
              onClick={confirmarImportacion}
            >
              2. Ejecutar importación transaccional (Origen: IMPORTADO)
            </button>
          </div>
        )}
      </section>
    </div>
  );
};
