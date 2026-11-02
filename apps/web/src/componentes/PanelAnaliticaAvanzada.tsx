import React, { useMemo, useState } from 'react';
import type * as echarts from 'echarts';
import {
  calcularCurvaLiquidezYDesviacion,
  calcularHeatmapTemporal,
  calcularParetoCategorias,
  calcularWaterfallFlujo,
  DIAS_SEMANA_LIMA,
  filtrarMovimientosAnalitica,
  type FiltroGlobalAnalitica,
  formatearMonto,
  hoyLima,
  mesDe,
  type MetricaHeatmap,
  type MovimientoFinanciero,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio } from '../persistencia/puerto';
import { LienzoECharts } from './LienzoECharts';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  periodoMesInicial: string;
  onNavegarAMovimientosConFiltro?: (params: {
    categoriaId?: string;
    eventoId?: string;
    cuentaId?: string;
  }) => void;
}

export const PanelAnaliticaAvanzada: React.FC<Props> = ({
  instantanea,
  periodoMesInicial,
  onNavegarAMovimientosConFiltro,
}) => {
  // Filtros globales de Analítica Avanzada
  const [modoPeriodo, setModoPeriodo] = useState<FiltroGlobalAnalitica['modoPeriodo']>('MES');
  const [mesFiltro, setMesFiltro] = useState<string>(periodoMesInicial || mesDe(hoyLima()));
  const [anioFiltro, setAnioFiltro] = useState<string>(() => hoyLima().slice(0, 4));
  const [desdeFiltro, setDesdeFiltro] = useState<string>('');
  const [hastaFiltro, setHastaFiltro] = useState<string>('');
  const [categoriaIdFiltro, setCategoriaIdFiltro] = useState<string>('');
  const [cuentaIdFiltro, setCuentaIdFiltro] = useState<string>('');
  const [tipoOperacionFiltro, setTipoOperacionFiltro] = useState<'TODOS' | 'INGRESO' | 'GASTO'>(
    'TODOS',
  );
  const [eventoIdFiltro, setEventoIdFiltro] = useState<string>('');
  const [etiquetaFiltro, setEtiquetaFiltro] = useState<string>('');

  // Métrica seleccionada en el Heatmap Temporal
  const [metricaHeatmap, setMetricaHeatmap] = useState<MetricaHeatmap>('IMPORTE_TOTAL');

  // Estado de drill-down interactivo (muestra las transacciones reales que componen el segmento pulsado)
  const [seleccionDrilldown, setSeleccionDrilldown] = useState<{
    titulo: string;
    movimientosIds: string[];
    categoriaId?: string;
  } | null>(null);

  const cuentasActivas = useMemo(
    () => instantanea.cuentas.filter((c) => c.estado === 'ACTIVO'),
    [instantanea.cuentas],
  );
  const categoriasActivas = useMemo(
    () => instantanea.categorias.filter((c) => c.estado === 'ACTIVO' && c.padreId === null),
    [instantanea.categorias],
  );
  const eventosActivos = useMemo(
    () => instantanea.eventos.filter((e) => e.estado === 'ACTIVO'),
    [instantanea.eventos],
  );
  const etiquetasDisponibles = useMemo(() => {
    const set = new Set<string>();
    for (const m of instantanea.movimientos) {
      if (m.estado === 'ACTIVO') {
        for (const t of m.etiquetas) set.add(t);
      }
    }
    return [...set];
  }, [instantanea.movimientos]);

  const mapaNombresCuentas = useMemo(
    () => new Map(instantanea.cuentas.map((c) => [c.id, c.nombre])),
    [instantanea.cuentas],
  );
  const mapaNombresCategorias = useMemo(
    () => new Map(instantanea.categorias.map((c) => [c.id, c.nombre])),
    [instantanea.categorias],
  );
  const mapaNombresEventos = useMemo(
    () => new Map(instantanea.eventos.map((e) => [e.id, e.nombre])),
    [instantanea.eventos],
  );

  const filtroGlobal: FiltroGlobalAnalitica = useMemo(
    () => ({
      modoPeriodo,
      mes: mesFiltro,
      anio: anioFiltro,
      desde: desdeFiltro || undefined,
      hasta: hastaFiltro || undefined,
      categoriaId: categoriaIdFiltro || undefined,
      cuentaId: cuentaIdFiltro || undefined,
      tipoOperacion: tipoOperacionFiltro,
      eventoId: eventoIdFiltro || undefined,
      etiqueta: etiquetaFiltro || undefined,
    }),
    [
      modoPeriodo,
      mesFiltro,
      anioFiltro,
      desdeFiltro,
      hastaFiltro,
      categoriaIdFiltro,
      cuentaIdFiltro,
      tipoOperacionFiltro,
      eventoIdFiltro,
      etiquetaFiltro,
    ],
  );

  const movimientosFiltrados = useMemo(
    () => filtrarMovimientosAnalitica(instantanea.movimientos, filtroGlobal),
    [instantanea.movimientos, filtroGlobal],
  );

  const mapaMovimientosPorId = useMemo(
    () => new Map(instantanea.movimientos.map((m) => [m.id, m])),
    [instantanea.movimientos],
  );

  // 1. Cálculo Waterfall
  const resultadoWaterfall = useMemo(
    () =>
      calcularWaterfallFlujo({
        movimientos: movimientosFiltrados,
        categorias: instantanea.categorias,
        reglasRecurrencia: instantanea.reglasRecurrencia,
      }),
    [movimientosFiltrados, instantanea.categorias, instantanea.reglasRecurrencia],
  );

  // 2. Cálculo Heatmap Temporal (24x7 en America/Lima)
  const resultadoHeatmap = useMemo(
    () => calcularHeatmapTemporal(movimientosFiltrados),
    [movimientosFiltrados],
  );

  // 3. Cálculo Curva de Liquidez y Desviación (±1σ, ±2σ)
  const resultadoLiquidez = useMemo(
    () =>
      calcularCurvaLiquidezYDesviacion({
        movimientos: movimientosFiltrados,
        movimientosCompletos: instantanea.movimientos,
        cuentas: instantanea.cuentas,
        cuentaFiltradaId: cuentaIdFiltro || undefined,
        tieneFiltroParcialNoBancario: Boolean(
          categoriaIdFiltro ||
            eventoIdFiltro ||
            etiquetaFiltro ||
            tipoOperacionFiltro !== 'TODOS',
        ),
      }),
    [
      movimientosFiltrados,
      instantanea.movimientos,
      instantanea.cuentas,
      cuentaIdFiltro,
      categoriaIdFiltro,
      eventoIdFiltro,
      etiquetaFiltro,
      tipoOperacionFiltro,
    ],
  );

  // 4. Cálculo Pareto 80/20
  const resultadoPareto = useMemo(
    () =>
      calcularParetoCategorias({
        movimientos: movimientosFiltrados,
        categorias: instantanea.categorias,
      }),
    [movimientosFiltrados, instantanea.categorias],
  );

  // ==================== OPCIONES ECHARTS ====================

  const opcionWaterfall: echarts.EChartsCoreOption | null = useMemo(() => {
    if (resultadoWaterfall.estado !== 'OK') return null;
    const { pasos } = resultadoWaterfall.datos;
    const etiquetas = pasos.map((p) => p.etiqueta);

    // Técnica estándar de cascada en ECharts: barra base transparente + barra con color según segmento
    const basesSoles = pasos.map((p) => {
      if (p.segmento === 'INGRESOS' || p.segmento === 'FLUJO_NETO') return 0;
      return Math.min(p.acumuladoDesdeCentimos, p.acumuladoHastaCentimos) / 100;
    });

    const alturasSoles = pasos.map((p, idx) => {
      const valSoles = p.montoAbsolutoCentimos / 100;
      const color =
        p.segmento === 'INGRESOS'
          ? '#16a34a'
          : p.segmento === 'FLUJO_NETO'
            ? p.montoConSignoCentimos >= 0
              ? '#2563eb'
              : '#dc2626'
            : p.segmento === 'GASTOS_EVENTOS'
              ? '#7c3aed'
              : '#e11d48';
      return {
        value: Number(valSoles.toFixed(2)),
        itemStyle: { color, borderRadius: [6, 6, 0, 0] },
        pasoIndice: idx,
      };
    });

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const primero = arr[0] as { dataIndex?: number } | undefined;
          const idx = primero?.dataIndex ?? 0;
          const paso = pasos[idx];
          if (!paso) return '';
          return `<strong>${paso.etiqueta}</strong><br/>Importe: <strong>${formatearMonto(paso.montoConSignoCentimos, 'PEN')}</strong><br/>Operaciones reales: ${paso.movimientosIds.length}<br/><em>Clic para ver transacciones</em>`;
        },
      },
      grid: { left: 60, right: 24, top: 28, bottom: 48 },
      xAxis: {
        type: 'category',
        data: etiquetas,
        axisLabel: { interval: 0, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        name: 'PEN (S/)',
      },
      series: [
        {
          name: 'Base',
          type: 'bar',
          stack: 'cascada',
          silent: true,
          itemStyle: { borderColor: 'transparent', color: 'transparent' },
          emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
          data: basesSoles,
        },
        {
          name: 'Flujo',
          type: 'bar',
          stack: 'cascada',
          label: {
            show: true,
            position: 'top',
            formatter: (p: { dataIndex: number }) => {
              const paso = pasos[p.dataIndex];
              return paso ? formatearMonto(paso.montoConSignoCentimos, 'PEN') : '';
            },
            fontSize: 11,
          },
          data: alturasSoles,
        },
      ],
    };
  }, [resultadoWaterfall]);

  const opcionHeatmap: echarts.EChartsCoreOption | null = useMemo(() => {
    if (resultadoHeatmap.estado !== 'OK') return null;
    const horas = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    const datosMatriz = resultadoHeatmap.datos.celdas.map((c) => {
      const valor =
        metricaHeatmap === 'FRECUENCIA'
          ? c.frecuencia
          : metricaHeatmap === 'IMPORTE_TOTAL'
            ? Number((c.importeTotalCentimos / 100).toFixed(2))
            : Number((c.importePromedioCentimos / 100).toFixed(2));
      return [c.hora, c.diaSemanaIndice, valor];
    });
    const maxValor = Math.max(1, ...datosMatriz.map((d) => d[2] ?? 0));

    return {
      tooltip: {
        position: 'top',
        formatter: (p: { data: [number, number, number] }) => {
          const [hora, diaIdx] = p.data;
          const celda = resultadoHeatmap.datos.celdas.find(
            (c) => c.hora === hora && c.diaSemanaIndice === diaIdx,
          );
          if (!celda) return '';
          return `<strong>${celda.diaSemanaNombre} ${String(hora).padStart(2, '0')}:00–${String(hora).padStart(2, '0')}:59 (Lima)</strong><br/>Operaciones: <strong>${celda.frecuencia}</strong><br/>Importe total: <strong>${formatearMonto(celda.importeTotalCentimos, 'PEN')}</strong><br/>Promedio/op: <strong>${formatearMonto(celda.importePromedioCentimos, 'PEN')}</strong>`;
        },
      },
      grid: { left: 82, right: 24, top: 20, bottom: 64 },
      xAxis: {
        type: 'category',
        data: horas,
        splitArea: { show: true },
        axisLabel: { fontSize: 10 },
      },
      yAxis: {
        type: 'category',
        data: [...DIAS_SEMANA_LIMA],
        splitArea: { show: true },
      },
      visualMap: {
        min: 0,
        max: maxValor,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 4,
        inRange: {
          color: ['#f8fafc', '#bae6fd', '#0284c7', '#1e3a8a'],
        },
      },
      series: [
        {
          name: 'Gastos por hora y día',
          type: 'heatmap',
          data: datosMatriz,
          label: {
            show: false,
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 6,
              shadowColor: 'rgba(0, 0, 0, 0.35)',
            },
          },
        },
      ],
    };
  }, [resultadoHeatmap, metricaHeatmap]);

  const opcionLiquidez: echarts.EChartsCoreOption | null = useMemo(() => {
    if (resultadoLiquidez.estado !== 'OK') return null;
    const { puntosDiarios, bandasEstadisticas } = resultadoLiquidez.datos;
    const fechas = puntosDiarios.map((p) => p.fecha);
    const flujoAcumSoles = puntosDiarios.map((p) =>
      Number((p.flujoAcumuladoRealCentimos / 100).toFixed(2)),
    );
    const gastoDiarioSoles = puntosDiarios.map((p) =>
      Number((p.gastoDiarioCentimos / 100).toFixed(2)),
    );
    const gastoAcumRealSoles = puntosDiarios.map((p) =>
      Number((p.gastoAcumuladoRealCentimos / 100).toFixed(2)),
    );

    const series: Record<string, unknown>[] = [
      {
        name: 'Gasto diario',
        type: 'bar',
        data: gastoDiarioSoles,
        itemStyle: { color: '#cbd5e1' },
      },
      {
        name: 'Flujo acumulado real',
        type: 'line',
        smooth: true,
        data: flujoAcumSoles,
        itemStyle: { color: '#0284c7' },
        lineStyle: { width: 2.5 },
      },
      {
        name: 'Gasto acumulado real S(t)',
        type: 'line',
        data: gastoAcumRealSoles,
        itemStyle: { color: '#dc2626' },
        lineStyle: { width: 2.5 },
      },
    ];

    if (bandasEstadisticas.estado === 'OK') {
      series.push(
        {
          name: 'Gasto acumulado esperado E[S(t)] = t×μ',
          type: 'line',
          data: puntosDiarios.map((p) =>
            p.gastoAcumuladoEsperadoCentimos !== null
              ? Number((p.gastoAcumuladoEsperadoCentimos / 100).toFixed(2))
              : null,
          ),
          itemStyle: { color: '#0f172a' },
          lineStyle: { type: 'dashed', width: 2 },
        },
        {
          name: 'Banda +1σ (E[S(t)] + σ√t)',
          type: 'line',
          data: puntosDiarios.map((p) =>
            p.bandaMas1SigmaCentimos !== null
              ? Number((p.bandaMas1SigmaCentimos / 100).toFixed(2))
              : null,
          ),
          itemStyle: { color: '#d97706' },
          lineStyle: { type: 'dotted', width: 1.5 },
          symbol: 'none',
        },
        {
          name: 'Banda -1σ (E[S(t)] - σ√t)',
          type: 'line',
          data: puntosDiarios.map((p) =>
            p.bandaMenos1SigmaCentimos !== null
              ? Number((p.bandaMenos1SigmaCentimos / 100).toFixed(2))
              : null,
          ),
          itemStyle: { color: '#d97706' },
          lineStyle: { type: 'dotted', width: 1.5 },
          symbol: 'none',
        },
        {
          name: 'Banda +2σ (E[S(t)] + 2σ√t)',
          type: 'line',
          data: puntosDiarios.map((p) =>
            p.bandaMas2SigmaCentimos !== null
              ? Number((p.bandaMas2SigmaCentimos / 100).toFixed(2))
              : null,
          ),
          itemStyle: { color: '#9333ea' },
          lineStyle: { type: 'dotted', width: 1.2 },
          symbol: 'none',
        },
        {
          name: 'Banda -2σ (E[S(t)] - 2σ√t)',
          type: 'line',
          data: puntosDiarios.map((p) =>
            p.bandaMenos2SigmaCentimos !== null
              ? Number((p.bandaMenos2SigmaCentimos / 100).toFixed(2))
              : null,
          ),
          itemStyle: { color: '#9333ea' },
          lineStyle: { type: 'dotted', width: 1.2 },
          symbol: 'none',
        },
      );
    }

    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 60, right: 24, top: 44, bottom: 44 },
      xAxis: { type: 'category', data: fechas },
      yAxis: { type: 'value', name: 'PEN (S/)' },
      series,
    };
  }, [resultadoLiquidez]);

  const opcionPareto: echarts.EChartsCoreOption | null = useMemo(() => {
    if (resultadoPareto.estado !== 'OK') return null;
    const { filas } = resultadoPareto.datos;
    const categoriasNombres = filas.map((f) => f.nombreCategoria);
    const importesSoles = filas.map((f) => Number((f.importeCentimos / 100).toFixed(2)));
    const acumuladosPct = filas.map((f) => Number((f.porcentajeAcumuladoBp / 100).toFixed(2)));

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: { data: ['Importe por categoría (S/)', '% Acumulado', 'Referencia 80%'], top: 0 },
      grid: { left: 60, right: 60, top: 40, bottom: 56 },
      xAxis: {
        type: 'category',
        data: categoriasNombres,
        axisLabel: { interval: 0, rotate: categoriasNombres.length > 4 ? 18 : 0 },
      },
      yAxis: [
        {
          type: 'value',
          name: 'PEN (S/)',
        },
        {
          type: 'value',
          name: '% Acumulado',
          min: 0,
          max: 100,
          axisLabel: { formatter: '{value}%' },
        },
      ],
      series: [
        {
          name: 'Importe por categoría (S/)',
          type: 'bar',
          data: importesSoles,
          itemStyle: {
            color: (p: { dataIndex: number }) =>
              filas[p.dataIndex]?.concentraNucleo80 ? '#2563eb' : '#94a3b8',
            borderRadius: [6, 6, 0, 0],
          },
        },
        {
          name: '% Acumulado',
          type: 'line',
          yAxisIndex: 1,
          data: acumuladosPct,
          itemStyle: { color: '#dc2626' },
          lineStyle: { width: 2.5 },
          markLine: {
            symbol: 'none',
            lineStyle: { color: '#16a34a', type: 'dashed', width: 2 },
            data: [{ yAxis: 80, name: 'Línea 80%' }],
            label: { formatter: '80% Pareto' },
          },
        },
      ],
    };
  }, [resultadoPareto]);

  const movimientosSeleccionadosDrilldown: MovimientoFinanciero[] = useMemo(() => {
    if (!seleccionDrilldown) return [];
    return seleccionDrilldown.movimientosIds
      .map((id) => mapaMovimientosPorId.get(id))
      .filter((m): m is MovimientoFinanciero => Boolean(m));
  }, [seleccionDrilldown, mapaMovimientosPorId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* BARRA DE FILTROS GLOBALES E INTERACTIVIDAD */}
      <section className="card">
        <div className="card-title">
          <span>Filtros Globales de Analítica Avanzada</span>
          <span className="badge badge-origen">
            {movimientosFiltrados.length} operación(es) real(es) en ventana
          </span>
        </div>

        <div className="chip-group" style={{ marginBottom: '12px' }}>
          {(
            [
              { id: 'MES', texto: 'Por Mes' },
              { id: 'ANIO', texto: 'Por Año' },
              { id: 'RANGO', texto: 'Rango de Fechas' },
              { id: 'TODO', texto: 'Todo el Historial' },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              className={`chip-btn ${modoPeriodo === m.id ? 'seleccionado' : ''}`}
              onClick={() => {
                setModoPeriodo(m.id);
                setSeleccionDrilldown(null);
              }}
            >
              {m.texto}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: '10px' }}>
          {modoPeriodo === 'MES' && (
            <input
              type="month"
              className="input-control"
              value={mesFiltro}
              onChange={(e) => setMesFiltro(e.target.value)}
              aria-label="Filtrar por mes"
            />
          )}
          {modoPeriodo === 'ANIO' && (
            <input
              type="number"
              min="2000"
              max="2100"
              className="input-control"
              value={anioFiltro}
              onChange={(e) => setAnioFiltro(e.target.value)}
              placeholder="Año (YYYY)"
              aria-label="Filtrar por año"
            />
          )}
          {modoPeriodo === 'RANGO' && (
            <>
              <input
                type="date"
                className="input-control"
                value={desdeFiltro}
                onChange={(e) => setDesdeFiltro(e.target.value)}
                aria-label="Fecha desde"
              />
              <input
                type="date"
                className="input-control"
                value={hastaFiltro}
                onChange={(e) => setHastaFiltro(e.target.value)}
                aria-label="Fecha hasta"
              />
            </>
          )}

          <select
            className="input-control"
            value={cuentaIdFiltro}
            onChange={(e) => setCuentaIdFiltro(e.target.value)}
          >
            <option value="">Todas las cuentas / métodos</option>
            {cuentasActivas.map((c) => (
              <option key={c.id} value={c.id}>
                Cuenta: {c.nombre}
              </option>
            ))}
          </select>

          <select
            className="input-control"
            value={categoriaIdFiltro}
            onChange={(e) => setCategoriaIdFiltro(e.target.value)}
          >
            <option value="">Todas las categorías</option>
            {categoriasActivas.map((c) => (
              <option key={c.id} value={c.id}>
                Categoría: {c.nombre}
              </option>
            ))}
          </select>

          <select
            className="input-control"
            value={tipoOperacionFiltro}
            onChange={(e) =>
              setTipoOperacionFiltro(e.target.value as 'TODOS' | 'INGRESO' | 'GASTO')
            }
          >
            <option value="TODOS">Ingresos y Gastos</option>
            <option value="GASTO">Solo Gastos</option>
            <option value="INGRESO">Solo Ingresos</option>
          </select>

          <select
            className="input-control"
            value={eventoIdFiltro}
            onChange={(e) => setEventoIdFiltro(e.target.value)}
          >
            <option value="">Con o sin evento</option>
            <option value="__SIN_EVENTO__">Solo cotidianos (sin evento)</option>
            {eventosActivos.map((ev) => (
              <option key={ev.id} value={ev.id}>
                Evento: {ev.nombre}
              </option>
            ))}
          </select>

          <select
            className="input-control"
            value={etiquetaFiltro}
            onChange={(e) => setEtiquetaFiltro(e.target.value)}
          >
            <option value="">Todas las etiquetas</option>
            {etiquetasDisponibles.map((t) => (
              <option key={t} value={t}>
                Etiqueta: {t}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* PANEL DE DRILL-DOWN INTERACTIVO AL SELECCIONAR UNA CATEGORÍA O SEGMENTO */}
      {seleccionDrilldown && (
        <section className="card" style={{ borderColor: '#2563eb', background: '#eff6ff' }}>
          <div className="card-title">
            <span>
              Transacciones que componen: <strong>{seleccionDrilldown.titulo}</strong> (
              {movimientosSeleccionadosDrilldown.length})
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {seleccionDrilldown.categoriaId && onNavegarAMovimientosConFiltro && (
                <button
                  type="button"
                  className="btn btn-primario"
                  style={{ minHeight: '34px', fontSize: '0.8rem' }}
                  onClick={() =>
                    onNavegarAMovimientosConFiltro({
                      categoriaId: seleccionDrilldown.categoriaId,
                    })
                  }
                >
                  Abrir en Libro de Movimientos
                </button>
              )}
              <button
                type="button"
                className="btn"
                style={{ minHeight: '34px', fontSize: '0.8rem' }}
                onClick={() => setSeleccionDrilldown(null)}
              >
                Cerrar detalle
              </button>
            </div>
          </div>

          {movimientosSeleccionadosDrilldown.length === 0 ? (
            <div className="estado-vacio">No hay movimientos en este segmento.</div>
          ) : (
            <div className="lista-movimientos" style={{ maxHeight: '240px', overflowY: 'auto' }}>
              {movimientosSeleccionadosDrilldown.map((m) => (
                <div key={m.id} className="item-movimiento">
                  <div>
                    <span className="badge badge-origen">{m.tipo}</span>{' '}
                    <strong>
                      {mapaNombresCategorias.get(m.categoriaId ?? '') ?? 'Categoría'} ·{' '}
                      {mapaNombresCuentas.get(m.cuentaId) ?? 'Cuenta'}
                    </strong>
                    {m.eventoId && (
                      <span className="badge badge-transferencia" style={{ marginLeft: '6px' }}>
                        Evento: {mapaNombresEventos.get(m.eventoId) ?? m.eventoId}
                      </span>
                    )}
                    <div style={{ fontSize: '0.78rem', color: '#475569', marginTop: '3px' }}>
                      {m.fechaMovimiento} {m.horaMovimiento}{' '}
                      {m.descripcion ? `· ${m.descripcion}` : ''}
                    </div>
                  </div>
                  <strong>{formatearMonto(m.montoCentimos, 'PEN')}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* GRILLA DE GRÁFICOS: 2 COLUMNAS AMPLIAS EN PC, 1 COLUMNA EN CELULAR */}
      <div className="analitica-grid-2col">
        {/* 1. WATERFALL CHART */}
        <section className="card">
          <div className="card-title">
            <span>1. Waterfall Chart: Descomposición Mutuamente Excluyente del Flujo</span>
            <span className="badge badge-origen">DERIVADO</span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            Ingresos − Gastos fijos − Gastos variables − Gastos asociados a eventos = Flujo neto.
            Un gasto vinculado a un evento nunca se suma dos veces como variable. Haz clic en una
            barra para inspeccionar sus transacciones.
          </p>

          {resultadoWaterfall.estado === 'HISTORIAL_INSUFICIENTE' || !opcionWaterfall ? (
            <div className="aviso-insuficiente">
              {resultadoWaterfall.estado === 'HISTORIAL_INSUFICIENTE'
                ? resultadoWaterfall.mensaje
                : 'Historial insuficiente.'}
            </div>
          ) : (
            <>
              <LienzoECharts
                opcion={opcionWaterfall}
                alturaPx={320}
                ariaLabel="Gráfico Waterfall de descomposición del flujo financiero"
                onClickElemento={(ev) => {
                  const idx = ev.dataIndex;
                  const paso = resultadoWaterfall.datos.pasos[idx];
                  if (paso) {
                    setSeleccionDrilldown({
                      titulo: `Waterfall — ${paso.etiqueta}`,
                      movimientosIds: paso.movimientosIds,
                    });
                  }
                }}
              />
              <div className="kpi-grid" style={{ marginTop: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
                {resultadoWaterfall.datos.pasos.map((p) => (
                  <button
                    key={p.segmento}
                    type="button"
                    className="kpi-box"
                    style={{ textAlign: 'left', cursor: 'pointer' }}
                    onClick={() =>
                      setSeleccionDrilldown({
                        titulo: `Waterfall — ${p.etiqueta}`,
                        movimientosIds: p.movimientosIds,
                      })
                    }
                  >
                    <div className="kpi-label">{p.etiqueta}</div>
                    <div style={{ fontWeight: 800, fontSize: '0.92rem', marginTop: '2px' }}>
                      {formatearMonto(p.montoConSignoCentimos, 'PEN')}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        {/* 4. PARETO 80/20 */}
        <section className="card">
          <div className="card-title">
            <span>4. Análisis de Pareto 80/20 por Categorías de Gasto</span>
            <span className="badge badge-origen">DERIVADO</span>
          </div>
          <p style={{ marginTop: 0, fontSize: '0.82rem', color: '#475569' }}>
            Ordena categorías según gasto real, muestra porcentaje individual, porcentaje acumulado
            y línea de referencia del 80%. Haz clic en una categoría para ver sus transacciones.
          </p>

          {resultadoPareto.estado === 'HISTORIAL_INSUFICIENTE' || !opcionPareto ? (
            <div className="aviso-insuficiente">
              {resultadoPareto.estado === 'HISTORIAL_INSUFICIENTE'
                ? resultadoPareto.mensaje
                : 'Historial insuficiente.'}
            </div>
          ) : (
            <>
              <LienzoECharts
                opcion={opcionPareto}
                alturaPx={320}
                ariaLabel="Diagrama de Pareto 80/20 de gastos por categoría"
                onClickElemento={(ev) => {
                  const fila = resultadoPareto.datos.filas[ev.dataIndex];
                  if (fila) {
                    setSeleccionDrilldown({
                      titulo: `Categoría Pareto — ${fila.nombreCategoria}`,
                      movimientosIds: fila.movimientosIds,
                      categoriaId: fila.categoriaId,
                    });
                  }
                }}
              />
              <div style={{ marginTop: '10px', fontSize: '0.83rem', color: '#1e293b' }}>
                <strong>Categorías que concentran el núcleo del 80% del gasto:</strong>{' '}
                {resultadoPareto.datos.categoriasVitales80.join(', ')}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 2. HEATMAP TEMPORAL (24 HORAS x 7 DÍAS EN AMERICA/LIMA) */}
      <section className="card">
        <div className="card-title" style={{ flexWrap: 'wrap' }}>
          <span>2. Heatmap Temporal de Gastos (Horas del día × Días de la semana en America/Lima)</span>
          <div className="chip-group">
            {(
              [
                { id: 'IMPORTE_TOTAL', texto: 'Importe gastado (S/)' },
                { id: 'FRECUENCIA', texto: 'Frecuencia de operaciones' },
                { id: 'IMPORTE_PROMEDIO', texto: 'Importe promedio / op' },
              ] as const
            ).map((op) => (
              <button
                key={op.id}
                type="button"
                className={`chip-btn ${metricaHeatmap === op.id ? 'seleccionado' : ''}`}
                onClick={() => setMetricaHeatmap(op.id)}
              >
                {op.texto}
              </button>
            ))}
          </div>
        </div>

        {resultadoHeatmap.estado === 'HISTORIAL_INSUFICIENTE' || !opcionHeatmap ? (
          <div className="aviso-insuficiente">
            {resultadoHeatmap.estado === 'HISTORIAL_INSUFICIENTE'
              ? resultadoHeatmap.mensaje
              : 'Historial insuficiente.'}
          </div>
        ) : (
          <LienzoECharts
            opcion={opcionHeatmap}
            alturaPx={340}
            minAnchoPx={640}
            ariaLabel="Mapa de calor temporal de gastos por hora y día de la semana en America/Lima"
            onClickElemento={(ev) => {
              const dato = ev.data as [number, number, number] | undefined;
              if (!dato) return;
              const [hora, diaIdx] = dato;
              const celda = resultadoHeatmap.datos.celdas.find(
                (c) => c.hora === hora && c.diaSemanaIndice === diaIdx,
              );
              if (celda && celda.movimientosIds.length > 0) {
                setSeleccionDrilldown({
                  titulo: `Heatmap — ${celda.diaSemanaNombre} ${String(hora).padStart(2, '0')}:00`,
                  movimientosIds: celda.movimientosIds,
                });
              }
            }}
          />
        )}
      </section>

      {/* 3. CURVA DE LIQUIDEZ DIARIA Y DESVIACIÓN (±1σ y ±2σ) */}
      <section className="card">
        <div className="card-title">
          <span>
            3. Curva de Liquidez Diaria, Gasto Acumulado Esperado E[S(t)] = t×μ y Bandas ±1σ / ±2σ
          </span>
          <span className="badge badge-origen">DERIVADO</span>
        </div>

        {resultadoLiquidez.estado === 'HISTORIAL_INSUFICIENTE' || !opcionLiquidez ? (
          <div className="aviso-insuficiente">
            {resultadoLiquidez.estado === 'HISTORIAL_INSUFICIENTE'
              ? resultadoLiquidez.mensaje
              : 'Historial insuficiente.'}
          </div>
        ) : (
          <>
            {resultadoLiquidez.datos.advertenciaSaldoBancario && (
              <div className="aviso-insuficiente" style={{ marginBottom: '10px' }}>
                {resultadoLiquidez.datos.advertenciaSaldoBancario}
              </div>
            )}

            {resultadoLiquidez.datos.bandasEstadisticas.estado === 'HISTORIAL_INSUFICIENTE' ? (
              <div className="aviso-insuficiente" style={{ marginBottom: '10px' }}>
                {resultadoLiquidez.datos.bandasEstadisticas.mensaje} Se grafica el flujo acumulado
                real y el gasto diario sin forzar bandas estadísticas ±1σ/±2σ.
              </div>
            ) : (
              <div
                style={{
                  marginBottom: '10px',
                  padding: '10px 12px',
                  background: '#f8fafc',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  fontSize: '0.82rem',
                  color: '#334155',
                }}
              >
                <div>
                  <strong>Parámetros sobre días con cobertura ({resultadoLiquidez.datos.bandasEstadisticas.datos.diasCobertura} días):</strong>{' '}
                  Media diaria μ ={' '}
                  <strong>
                    {formatearMonto(
                      resultadoLiquidez.datos.bandasEstadisticas.datos.mediaDiariaCentimos,
                      'PEN',
                    )}
                  </strong>{' '}
                  · Desviación estándar diaria σ ={' '}
                  <strong>
                    {formatearMonto(
                      resultadoLiquidez.datos.bandasEstadisticas.datos.desviacionEstandarDiariaCentimos,
                      'PEN',
                    )}
                  </strong>
                </div>
                <div style={{ marginTop: '4px', fontStyle: 'italic' }}>
                  {resultadoLiquidez.datos.bandasEstadisticas.datos.notaMetodologica}
                </div>
              </div>
            )}

            <LienzoECharts
              opcion={opcionLiquidez}
              alturaPx={360}
              ariaLabel="Curva diaria de liquidez, gasto acumulado esperado y bandas de variabilidad"
            />
          </>
        )}
      </section>
    </div>
  );
};
