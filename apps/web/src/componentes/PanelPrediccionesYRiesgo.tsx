import React, { useMemo, useRef, useState } from 'react';
import type * as echarts from 'echarts';
import {
  CachePrediccionesFinancieras,
  formatearMonto,
  hoyLima,
  UMBRAL_Z_DEFAULT,
} from '@mis-cuentas/core';
import type { EstadoInstantaneoRepositorio } from '../persistencia/puerto';
import { LienzoECharts } from './LienzoECharts';

interface Props {
  instantanea: EstadoInstantaneoRepositorio;
  periodoMes: string;
  onIrAMovimiento?: (movimientoId: string | null, categoriaId: string | null) => void;
}

export const PanelPrediccionesYRiesgo: React.FC<Props> = ({
  instantanea,
  periodoMes,
  onIrAMovimiento,
}) => {
  const [umbralZ, setUmbralZ] = useState<number>(UMBRAL_Z_DEFAULT);
  const fechaCorteLima = useMemo(() => hoyLima(), []);

  // Instancia persistente de caché que evita re-ejecutar backtesting y 1,000 simulaciones
  // en renders donde las transacciones o parámetros relevantes no han cambiado.
  const cacheRef = useRef<CachePrediccionesFinancieras>(new CachePrediccionesFinancieras());

  const resultadoCache = useMemo(() => {
    return cacheRef.current.obtenerOCalcular({
      periodoMes,
      fechaCorteLima,
      movimientos: instantanea.movimientos,
      cuentas: instantanea.cuentas,
      categorias: instantanea.categorias,
      presupuestos: instantanea.presupuestos,
      eventos: instantanea.eventos,
      gastosPlanificados: instantanea.gastosPlanificados,
      umbralZAnomalias: umbralZ,
      iteracionesMonteCarlo: 1000,
    });
  }, [
    periodoMes,
    fechaCorteLima,
    instantanea.movimientos,
    instantanea.cuentas,
    instantanea.categorias,
    instantanea.presupuestos,
    instantanea.eventos,
    instantanea.gastosPlanificados,
    umbralZ,
  ]);

  const { reporte, huella, estadisticasCache } = resultadoCache;
  const { proyeccionFinDeMes, proyeccionesEventos, anomaliasDetectadas } = reporte;

  // Opción de ECharts para el histograma de las 1,000 simulaciones de Monte Carlo mensual
  const opcionMonteCarloMensual = useMemo<echarts.EChartsOption | null>(() => {
    if (proyeccionFinDeMes.estado !== 'OK') return null;
    const mc = proyeccionFinDeMes.datos.monteCarloMensual;
    if (mc.estado !== 'OK') return null;

    const cubetas = mc.datos.histogramaDistribución;
    const etiquetas = cubetas.map(
      (c) =>
        `S/ ${(c.desdeCentimos / 100).toFixed(0)}–${(c.hastaCentimos / 100).toFixed(0)}`,
    );
    const frecuencias = cubetas.map((c) => c.frecuencia);
    const presupuesto = mc.datos.presupuestoObjetivoCentimos;

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const p0 = arr[0] as { dataIndex?: number } | undefined;
          const idx = p0?.dataIndex ?? 0;
          const cub = cubetas[idx];
          if (!cub) return '';
          return [
            `<strong>Rango de gasto final simulado:</strong>`,
            `${formatearMonto(cub.desdeCentimos, 'PEN')} a ${formatearMonto(cub.hastaCentimos, 'PEN')}`,
            `Simulaciones: <strong>${cub.frecuencia} de ${mc.datos.numeroSimulaciones}</strong> (${(
              cub.probabilidad * 100
            ).toFixed(1)}%)`,
          ].join('<br/>');
        },
      },
      grid: { left: 54, right: 24, top: 28, bottom: 58 },
      xAxis: {
        type: 'category',
        data: etiquetas,
        axisLabel: { rotate: 22, fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        name: 'Iteraciones',
      },
      series: [
        {
          name: 'Frecuencia Monte Carlo',
          type: 'bar',
          data: frecuencias.map((freq, idx) => {
            const cub = cubetas[idx]!;
            const excede =
              presupuesto !== null && cub.desdeCentimos > presupuesto;
            return {
              value: freq,
              itemStyle: {
                color: excede ? '#dc2626' : '#2563eb',
                borderRadius: [4, 4, 0, 0],
              },
            };
          }),
        },
      ],
    };
  }, [proyeccionFinDeMes]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {/* ==================== CABECERA METODOLÓGICA Y ESTADO DE CACHÉ ==================== */}
      <section className="card">
        <div className="card-title">
          <span>Motor Estadístico de Predicciones y Riesgo Financiero ({periodoMes})</span>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span className="badge badge-origen">PROYECTADO / DERIVADO</span>
            <span
              className="badge badge-origen"
              title="Caché determinista con invalidación automática al cambiar transacciones"
            >
              Caché: {estadisticasCache.ejecucionesReales} cálculo(s) · Huella #{huella.slice(-8)}
            </span>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: '0.86rem', color: '#475569' }}>
          Todas las estimaciones se calculan exclusivamente sobre tu historial financiero real (0 datos sintéticos).
          Los modelos de series temporales (<strong>MCO</strong>, <strong>SES</strong>, <strong>Holt</strong> y{' '}
          <strong>Holt-Winters semanal</strong>) se comparan mediante validación temporal fuera de muestra
          (<em>walk-forward</em> cronológico sin mezclar pasado y futuro). Las proyecciones incluyen intervalos del
          95 % y 1,000 simulaciones de Monte Carlo por Bootstrap no paramétrico.
        </p>
      </section>

      {/* ==================== 1. PROYECCIÓN A FIN DE MES + INTERVALOS 95% + CALIDAD DE DATOS ==================== */}
      <section className="card">
        <div className="card-title">
          <span>1. Proyección a Fin de Mes ({periodoMes}) e Intervalos del 95 %</span>
          <span className="badge badge-origen">PROYECTADO</span>
        </div>

        {proyeccionFinDeMes.estado === 'HISTORIAL_INSUFICIENTE' ? (
          <div className="aviso-insuficiente" role="status">
            <strong>Historial insuficiente:</strong> {proyeccionFinDeMes.mensaje}
            <div style={{ marginTop: '6px', fontSize: '0.8rem' }}>
              El motor no fuerza modelos estadísticos ni inventa proyecciones cuando no existen suficientes días reales
              observados.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* KPIs principales de la proyección mensual */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '10px',
              }}
            >
              <div className="kpi-box">
                <div className="kpi-label">
                  Gasto real acumulado ({proyeccionFinDeMes.datos.diasTranscurridosMes}/
                  {proyeccionFinDeMes.datos.diasTotalesMes} días)
                </div>
                <div className="kpi-value egreso">
                  {formatearMonto(proyeccionFinDeMes.datos.gastosRealesAcumuladosMesCentimos, 'PEN')}
                </div>
              </div>

              <div className="kpi-box">
                <div className="kpi-label">
                  Gasto total esperado a fin de mes (+{proyeccionFinDeMes.datos.diasRestantesMes}d)
                </div>
                <div className="kpi-value egreso">
                  {formatearMonto(proyeccionFinDeMes.datos.gastoTotalEsperadoFinDeMesCentimos, 'PEN')}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                  Restante estimado:{' '}
                  {formatearMonto(proyeccionFinDeMes.datos.gastoRestanteProyectadoCentimos, 'PEN')}
                </div>
              </div>

              <div className="kpi-box">
                <div className="kpi-label">Ingresos esperados del mes</div>
                <div className="kpi-value ingreso">
                  {formatearMonto(proyeccionFinDeMes.datos.ingresoTotalEsperadoFinDeMesCentimos, 'PEN')}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                  {proyeccionFinDeMes.datos.proyeccionIngresos.estado === 'OK'
                    ? `Modelo: ${proyeccionFinDeMes.datos.proyeccionIngresos.datos.metodoSeleccionado}`
                    : 'Solo ingresos ya registrados (historial insuficiente para extrapolar)'}
                </div>
              </div>

              <div className="kpi-box">
                <div className="kpi-label">Flujo neto proyectado al cierre</div>
                <div
                  className={`kpi-value ${
                    proyeccionFinDeMes.datos.flujoNetoProyectadoFinDeMesCentimos >= 0
                      ? 'ingreso'
                      : 'egreso'
                  }`}
                >
                  {formatearMonto(proyeccionFinDeMes.datos.flujoNetoProyectadoFinDeMesCentimos, 'PEN')}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                  {proyeccionFinDeMes.datos.saldoBancarioProyectadoFinDeMesCentimos !== null
                    ? `Saldo bancario proyectado: ${formatearMonto(
                        proyeccionFinDeMes.datos.saldoBancarioProyectadoFinDeMesCentimos,
                        'PEN',
                      )}`
                    : 'Saldo bancario no proyectado (falta saldo inicial en cuentas)'}
                </div>
              </div>

              <div className="kpi-box">
                <div className="kpi-label">Presupuesto mensual restante proyectado</div>
                <div className="kpi-value">
                  {proyeccionFinDeMes.datos.presupuestoRestanteProyectadoFinDeMesCentimos !== null
                    ? formatearMonto(
                        proyeccionFinDeMes.datos.presupuestoRestanteProyectadoFinDeMesCentimos,
                        'PEN',
                      )
                    : 'Sin presupuesto mensual'}
                </div>
                {proyeccionFinDeMes.datos.diferenciaRespectoPresupuestoInicialCentimos !== null && (
                  <div
                    style={{
                      fontSize: '0.75rem',
                      marginTop: '2px',
                      color:
                        proyeccionFinDeMes.datos.diferenciaRespectoPresupuestoInicialCentimos > 0
                          ? '#b91c1c'
                          : '#15803d',
                    }}
                  >
                    {proyeccionFinDeMes.datos.diferenciaRespectoPresupuestoInicialCentimos > 0
                      ? `Exceso proyectado vs. presupuesto inicial: +${formatearMonto(
                          proyeccionFinDeMes.datos.diferenciaRespectoPresupuestoInicialCentimos,
                          'PEN',
                        )}`
                      : `Ahorro proyectado vs. presupuesto inicial: ${formatearMonto(
                          Math.abs(
                            proyeccionFinDeMes.datos.diferenciaRespectoPresupuestoInicialCentimos,
                          ),
                          'PEN',
                        )}`}
                  </div>
                )}
              </div>
            </div>

            {/* Diferenciación explícita: Intervalo de Confianza de la Media (95%) vs. Intervalo de Predicción (95%) */}
            <div className="analitica-grid-2col">
              <div className="kpi-box" style={{ background: '#eff6ff', borderColor: '#bfdbfe' }}>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#1e3a8a' }}>
                  Intervalo de Confianza del 95 % de la MEDIA esperada
                </div>
                <div style={{ fontSize: '1.08rem', fontWeight: 800, marginTop: '4px', color: '#1d4ed8' }}>
                  {formatearMonto(
                    proyeccionFinDeMes.datos.intervalosGasto95.intervaloConfianzaMedia95
                      .inferiorCentimos,
                    'PEN',
                  )}{' '}
                  —{' '}
                  {formatearMonto(
                    proyeccionFinDeMes.datos.intervalosGasto95.intervaloConfianzaMedia95
                      .superiorCentimos,
                    'PEN',
                  )}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#334155', marginTop: '4px' }}>
                  Mide la incertidumbre sobre el promedio esperado de la trayectoria (error de estimación de parámetros
                  del modelo).
                </div>
              </div>

              <div className="kpi-box" style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#7f1d1d' }}>
                  Intervalo de Predicción del 95 % de la OBSERVACIÓN futura
                </div>
                <div style={{ fontSize: '1.08rem', fontWeight: 800, marginTop: '4px', color: '#b91c1c' }}>
                  {formatearMonto(
                    proyeccionFinDeMes.datos.intervalosGasto95.intervaloPrediccionObservacion95
                      .inferiorCentimos,
                    'PEN',
                  )}{' '}
                  —{' '}
                  {formatearMonto(
                    proyeccionFinDeMes.datos.intervalosGasto95.intervaloPrediccionObservacion95
                      .superiorCentimos,
                    'PEN',
                  )}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#334155', marginTop: '4px' }}>
                  Rango donde se espera que caiga el gasto real al finalizar el mes (suma la incertidumbre de la media +
                  la varianza diaria futura σ̂_ε ={' '}
                  {formatearMonto(
                    proyeccionFinDeMes.datos.intervalosGasto95.diagnosticoResiduos
                      .desviacionErrorCentimos,
                    'PEN',
                  )}
                  ).
                </div>
              </div>
            </div>

            {/* Tabla de Selección de Método y Backtesting Temporal Fuera de Muestra */}
            <div className="kpi-box">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
                <strong>
                  Método Estadístico Seleccionado:{' '}
                  <span style={{ color: '#2563eb' }}>
                    {
                      proyeccionFinDeMes.datos.seleccionModeloGastos.modeloFinalReentrenado
                        .parametros.nombreLegible
                    }
                  </span>
                </strong>
                <span className="badge badge-origen">
                  Backtesting Walk-Forward ({proyeccionFinDeMes.datos.seleccionModeloGastos.pasosValidacionOutSample} cortes cronológicos)
                </span>
              </div>
              <p style={{ margin: '0 0 10px 0', fontSize: '0.82rem', color: '#475569' }}>
                {proyeccionFinDeMes.datos.seleccionModeloGastos.justificacionSeleccion}
                <br />
                Fórmula:{' '}
                <code>
                  {
                    proyeccionFinDeMes.datos.seleccionModeloGastos.modeloFinalReentrenado
                      .parametros.formulaResumen
                  }
                </code>
              </p>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #cbd5e1', textAlign: 'left' }}>
                      <th style={{ padding: '6px' }}>Método evaluado</th>
                      <th style={{ padding: '6px' }}>Estado</th>
                      <th style={{ padding: '6px' }}>RMSE (fuera de muestra)</th>
                      <th style={{ padding: '6px' }}>MAE (fuera de muestra)</th>
                      <th style={{ padding: '6px' }}>Sesgo medio</th>
                      <th style={{ padding: '6px' }}>sMAPE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proyeccionFinDeMes.datos.seleccionModeloGastos.comparativaModelos.map((m) => {
                      const esGanador =
                        m.metodo ===
                        proyeccionFinDeMes.datos.seleccionModeloGastos.metodoSeleccionado;
                      return (
                        <tr
                          key={m.metodo}
                          style={{
                            borderBottom: '1px solid #e2e8f0',
                            background: esGanador ? '#eff6ff' : 'transparent',
                            fontWeight: esGanador ? 700 : 400,
                          }}
                        >
                          <td style={{ padding: '6px' }}>
                            {m.nombreLegible} {esGanador && '★ (Seleccionado)'}
                          </td>
                          <td style={{ padding: '6px' }}>
                            {m.evaluado ? 'Evaluado' : `Omitido (${m.motivoNoEvaluado})`}
                          </td>
                          <td style={{ padding: '6px' }}>
                            {m.rmseOutSampleCentimos !== null
                              ? formatearMonto(m.rmseOutSampleCentimos, 'PEN')
                              : '—'}
                          </td>
                          <td style={{ padding: '6px' }}>
                            {m.maeOutSampleCentimos !== null
                              ? formatearMonto(m.maeOutSampleCentimos, 'PEN')
                              : '—'}
                          </td>
                          <td style={{ padding: '6px' }}>
                            {m.sesgoMedioOutSampleCentimos !== null
                              ? formatearMonto(m.sesgoMedioOutSampleCentimos, 'PEN')
                              : '—'}
                          </td>
                          <td style={{ padding: '6px' }}>
                            {m.smapeOutSamplePorcentaje !== null
                              ? `${m.smapeOutSamplePorcentaje.toFixed(1)}%`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Calidad y suficiencia de los datos + diagnóstico de residuos */}
            <div className="kpi-box" style={{ fontSize: '0.82rem', color: '#334155' }}>
              <strong>Calidad y suficiencia de datos observados:</strong>{' '}
              {proyeccionFinDeMes.datos.calidadDatosGastos.resumenCalidad}
              <div style={{ marginTop: '4px' }}>
                Media diaria observada:{' '}
                <strong>
                  {formatearMonto(
                    proyeccionFinDeMes.datos.calidadDatosGastos.mediaDiariaCentimos,
                    'PEN',
                  )}
                </strong>{' '}
                · Desviación diaria:{' '}
                <strong>
                  {formatearMonto(
                    proyeccionFinDeMes.datos.calidadDatosGastos.desviacionDiariaCentimos,
                    'PEN',
                  )}
                </strong>{' '}
                · Días sin gasto:{' '}
                <strong>
                  {(proyeccionFinDeMes.datos.calidadDatosGastos.proporcionCeros * 100).toFixed(1)}%
                </strong>{' '}
                · Autocorrelación lag-1:{' '}
                <strong>
                  {proyeccionFinDeMes.datos.calidadDatosGastos.autocorrelacionLag1.toFixed(2)}
                </strong>
              </div>
              {proyeccionFinDeMes.datos.intervalosGasto95.advertenciasIncertidumbre.length > 0 && (
                <ul style={{ margin: '6px 0 0 18px', padding: 0, color: '#b45309' }}>
                  {proyeccionFinDeMes.datos.intervalosGasto95.advertenciasIncertidumbre.map(
                    (adv, i) => (
                      <li key={i}>{adv}</li>
                    ),
                  )}
                </ul>
              )}
              <div style={{ marginTop: '6px', fontStyle: 'italic', color: '#64748b' }}>
                {proyeccionFinDeMes.datos.notaNoEsCerteza}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ==================== 2. SIMULACIÓN DE MONTE CARLO (1,000 ITERACIONES) ==================== */}
      <section className="card">
        <div className="card-title">
          <span>2. Simulación de Monte Carlo (1,000 Iteraciones — Riesgo Presupuestario Mensual)</span>
          <span className="badge badge-origen">PROYECTADO</span>
        </div>

        {proyeccionFinDeMes.estado === 'HISTORIAL_INSUFICIENTE' ? (
          <div className="aviso-insuficiente">
            <strong>Historial insuficiente:</strong> {proyeccionFinDeMes.mensaje}
          </div>
        ) : proyeccionFinDeMes.datos.monteCarloMensual.estado === 'HISTORIAL_INSUFICIENTE' ? (
          <div className="aviso-insuficiente">
            <strong>Historial insuficiente:</strong>{' '}
            {proyeccionFinDeMes.datos.monteCarloMensual.mensaje}
          </div>
        ) : (
          (() => {
            const mc = proyeccionFinDeMes.datos.monteCarloMensual.datos;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                    gap: '10px',
                  }}
                >
                  <div className="kpi-box">
                    <div className="kpi-label">Probabilidad de superar presupuesto mensual</div>
                    <div
                      className={`kpi-value ${
                        mc.probabilidadSuperarPresupuesto !== null &&
                        mc.probabilidadSuperarPresupuesto >= 0.5
                          ? 'egreso'
                          : ''
                      }`}
                    >
                      {mc.probabilidadSuperarPresupuesto !== null
                        ? `${(mc.probabilidadSuperarPresupuesto * 100).toFixed(1)}%`
                        : 'Sin presupuesto definido'}
                    </div>
                    {mc.simulacionesQueExcedenPresupuesto !== null && (
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {mc.simulacionesQueExcedenPresupuesto} de {mc.numeroSimulaciones} trayectorias
                        superan {formatearMonto(mc.presupuestoObjetivoCentimos ?? 0, 'PEN')}
                      </div>
                    )}
                  </div>

                  <div className="kpi-box">
                    <div className="kpi-label">Escenario Favorable (P10)</div>
                    <div className="kpi-value ingreso">
                      {formatearMonto(mc.escenarioFavorableP10Centimos, 'PEN')}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      10 % de las trayectorias terminan por debajo
                    </div>
                  </div>

                  <div className="kpi-box">
                    <div className="kpi-label">Escenario Central (Mediana P50)</div>
                    <div className="kpi-value">
                      {formatearMonto(mc.escenarioCentralMedianaCentimos, 'PEN')}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      Media simulada: {formatearMonto(mc.mediaSimuladaCentimos, 'PEN')}
                    </div>
                  </div>

                  <div className="kpi-box">
                    <div className="kpi-label">Escenario Desfavorable (P90)</div>
                    <div className="kpi-value egreso">
                      {formatearMonto(mc.escenarioDesfavorableP90Centimos, 'PEN')}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                      Rango 95 % empírico: {formatearMonto(mc.percentil2_5Centimos, 'PEN')} –{' '}
                      {formatearMonto(mc.percentil97_5Centimos, 'PEN')}
                    </div>
                  </div>
                </div>

                {opcionMonteCarloMensual && (
                  <LienzoECharts
                    opcion={opcionMonteCarloMensual}
                    alturaPx={270}
                    ariaLabel="Distribución de gasto mensual simulado por Monte Carlo (1,000 iteraciones)"
                  />
                )}

                {/* Ficha técnica obligatoria de Monte Carlo */}
                <div className="kpi-box" style={{ fontSize: '0.8rem', color: '#334155' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginBottom: '6px' }}>
                    <span>
                      <strong>N.º de observaciones:</strong> {mc.numeroObservaciones} días ({mc.diasConGastoObservados}{' '}
                      con gasto)
                    </span>
                    <span>
                      <strong>Periodo analizado:</strong> {mc.periodoAnalizado.desde} a{' '}
                      {mc.periodoAnalizado.hasta}
                    </span>
                    <span>
                      <strong>Método utilizado:</strong>{' '}
                      {mc.metodoUtilizado === 'BOOTSTRAP_BLOQUES_MOVILES'
                        ? `Bootstrap por Bloques Móviles (bloque = ${mc.longitudBloqueDias} días)`
                        : 'Bootstrap Empírico IID'}
                    </span>
                    <span>
                      <strong>N.º de simulaciones:</strong> {mc.numeroSimulaciones}
                    </span>
                  </div>
                  <div>
                    <strong>Supuestos:</strong> {mc.supuestos.join(' ')}
                  </div>
                  <div style={{ marginTop: '4px', color: '#64748b' }}>
                    <strong>Limitaciones:</strong> {mc.limitaciones.join(' ')}
                  </div>
                </div>
              </div>
            );
          })()
        )}
      </section>

      {/* ==================== 3. PROYECCIÓN A FIN DE CADA EVENTO + MONTE CARLO POR EVENTO ==================== */}
      <section className="card">
        <div className="card-title">
          <span>3. Proyección a Fin de Cada Evento y Riesgo de Exceder su Presupuesto</span>
          <span className="badge badge-origen">PROYECTADO</span>
        </div>

        {proyeccionesEventos.length === 0 ? (
          <div className="estado-vacio">
            No hay eventos configurados actualmente. Cuando crees un viaje, proyecto o evento en la pestaña{' '}
            <strong>Eventos</strong>, aquí se calculará su proyección de cierre y su riesgo de Monte Carlo.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {proyeccionesEventos.map((ev) => (
              <div key={ev.eventoId} className="kpi-box">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '8px',
                    marginBottom: '8px',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: '1rem' }}>{ev.nombreEvento}</strong>{' '}
                    <span className="badge badge-origen">{ev.tipoEvento}</span>{' '}
                    <span className="badge badge-origen">{ev.estadoEvento}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                    {ev.fechaInicio} → {ev.fechaFin} ({ev.diasTranscurridosEvento}/{ev.diasTotalesEvento} días ·{' '}
                    {ev.diasRestantesEvento} restantes)
                  </div>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
                    gap: '8px',
                    marginBottom: '10px',
                  }}
                >
                  <div>
                    <div className="kpi-label">Presupuesto inicial</div>
                    <strong>{formatearMonto(ev.presupuestoInicialEventoCentimos, 'PEN')}</strong>
                  </div>
                  <div>
                    <div className="kpi-label">Gasto real + Comprometido</div>
                    <strong>
                      {formatearMonto(ev.gastoRealAcumuladoEventoCentimos, 'PEN')} +{' '}
                      {formatearMonto(ev.gastoComprometidoPendienteCentimos, 'PEN')}
                    </strong>
                  </div>
                  <div>
                    <div className="kpi-label">Presupuesto restante actual</div>
                    <strong>{formatearMonto(ev.presupuestoRestanteActualCentimos, 'PEN')}</strong>
                  </div>
                </div>

                {ev.estimacionCierre.estado === 'HISTORIAL_INSUFICIENTE' ? (
                  <div className="aviso-insuficiente">
                    <strong>Historial insuficiente en este evento:</strong>{' '}
                    {ev.estimacionCierre.mensaje}
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                      gap: '10px',
                      background: '#ffffff',
                      padding: '10px',
                      borderRadius: '8px',
                      border: '1px solid #e2e8f0',
                    }}
                  >
                    <div>
                      <div className="kpi-label">
                        Gasto esperado al fin del evento ({ev.estimacionCierre.datos.seleccionModelo.metodoSeleccionado})
                      </div>
                      <div className="kpi-value egreso" style={{ fontSize: '1rem' }}>
                        {formatearMonto(
                          ev.estimacionCierre.datos.gastoTotalEsperadoFinEventoCentimos,
                          'PEN',
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        Diferencia vs. presupuesto:{' '}
                        {formatearMonto(
                          ev.estimacionCierre.datos.diferenciaRespectoPresupuestoInicialCentimos,
                          'PEN',
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="kpi-label">Intervalo de Predicción 95 % (Evento)</div>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                        {formatearMonto(
                          ev.estimacionCierre.datos.intervalos95.intervaloPrediccionObservacion95
                            .inferiorCentimos,
                          'PEN',
                        )}{' '}
                        —{' '}
                        {formatearMonto(
                          ev.estimacionCierre.datos.intervalos95.intervaloPrediccionObservacion95
                            .superiorCentimos,
                          'PEN',
                        )}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        IC Media 95 %:{' '}
                        {formatearMonto(
                          ev.estimacionCierre.datos.intervalos95.intervaloConfianzaMedia95
                            .inferiorCentimos,
                          'PEN',
                        )}{' '}
                        –{' '}
                        {formatearMonto(
                          ev.estimacionCierre.datos.intervalos95.intervaloConfianzaMedia95
                            .superiorCentimos,
                          'PEN',
                        )}
                      </div>
                    </div>

                    {ev.monteCarloEvento.estado === 'OK' && (
                      <div>
                        <div className="kpi-label">
                          Probabilidad Monte Carlo de exceder presupuesto (1,000 sim.)
                        </div>
                        <div
                          style={{
                            fontWeight: 800,
                            fontSize: '1rem',
                            color:
                              (ev.monteCarloEvento.datos.probabilidadSuperarPresupuesto ?? 0) >= 0.5
                                ? '#b91c1c'
                                : '#15803d',
                          }}
                        >
                          {ev.monteCarloEvento.datos.probabilidadSuperarPresupuesto !== null
                            ? `${(
                                ev.monteCarloEvento.datos.probabilidadSuperarPresupuesto * 100
                              ).toFixed(1)}%`
                            : 'Sin presupuesto objetivo'}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                          P10:{' '}
                          {formatearMonto(
                            ev.monteCarloEvento.datos.escenarioFavorableP10Centimos,
                            'PEN',
                          )}{' '}
                          · P50:{' '}
                          {formatearMonto(
                            ev.monteCarloEvento.datos.escenarioCentralMedianaCentimos,
                            'PEN',
                          )}{' '}
                          · P90:{' '}
                          {formatearMonto(
                            ev.monteCarloEvento.datos.escenarioDesfavorableP90Centimos,
                            'PEN',
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ==================== 4. DETECCIÓN DE ANOMALÍAS (Z-SCORE Y Z-SCORE ROBUSTO MAD) ==================== */}
      <section className="card">
        <div className="card-title">
          <span>4. Detección Automática de Anomalías y Gastos Atípicos</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <label htmlFor="umbral-z-input" style={{ fontSize: '0.8rem', fontWeight: 600 }}>
              Umbral Z &gt;
            </label>
            <input
              id="umbral-z-input"
              type="number"
              step="0.25"
              min="1.25"
              max="5"
              className="input-control"
              style={{ width: '82px', minHeight: '34px', padding: '4px 8px' }}
              value={umbralZ}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isNaN(v) && v >= 1.0 && v <= 6.0) {
                  setUmbralZ(v);
                }
              }}
            />
          </div>
        </div>

        {anomaliasDetectadas.estado === 'HISTORIAL_INSUFICIENTE' ? (
          <div className="aviso-insuficiente">
            <strong>Historial insuficiente:</strong> {anomaliasDetectadas.mensaje}
          </div>
        ) : anomaliasDetectadas.datos.alertas.length === 0 ? (
          <div className="estado-vacio">
            No se detectaron gastos atípicos por encima del umbral Z &gt; {umbralZ.toFixed(2)} en las{' '}
            {anomaliasDetectadas.datos.totalGastosAnalizados} operaciones analizadas.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '0.82rem', color: '#475569' }}>
              {anomaliasDetectadas.datos.notaMetodologica}
            </div>
            <div className="lista-movimientos">
              {anomaliasDetectadas.datos.alertas.map((alerta) => (
                <article key={alerta.id} className="item-movimiento">
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                      <span
                        className={`badge ${
                          alerta.severidad === 'ALTA' ? 'badge-gasto' : 'badge-origen'
                        }`}
                      >
                        {alerta.tipoAlerta}
                      </span>
                      <span className="badge badge-origen">
                        Z clásico: {alerta.zScoreClasico} · Z robusto (MAD): {alerta.zScoreRobustoMad}
                      </span>
                      <strong>{alerta.titulo}</strong>
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '0.84rem', color: '#1e293b' }}>
                      {alerta.explicacionEstadistica}
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '0.76rem', color: '#64748b' }}>
                      Fecha: <strong>{alerta.fecha}</strong> · Media ref.:{' '}
                      {formatearMonto(alerta.referenciaMediaCentimos, 'PEN')} · Mediana ref.:{' '}
                      {formatearMonto(alerta.referenciaMedianaCentimos, 'PEN')} ({alerta.observacionesComparables}{' '}
                      obs.)
                    </div>
                    <div style={{ marginTop: '4px', fontSize: '0.74rem', color: '#b45309' }}>
                      {alerta.notaNoEsFraude}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                    <strong style={{ color: '#b91c1c', fontSize: '1rem' }}>
                      {formatearMonto(alerta.montoObservadoCentimos, 'PEN')}
                    </strong>
                    {onIrAMovimiento && (
                      <button
                        type="button"
                        className="btn"
                        style={{ minHeight: '32px', padding: '4px 10px', fontSize: '0.76rem' }}
                        onClick={() => onIrAMovimiento(alerta.movimientoId, alerta.categoriaId)}
                      >
                        Revisar en movimientos
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
