/**
 * Fase 4 — Proyecciones Financieras (A. Fin de Mes y B. Fin de cada Evento).
 *
 * Calcula:
 *  - Saldo o flujo neto proyectado.
 *  - Gastos esperados (seleccionando entre MCO, SES, Holt y Holt-Winters por backtesting).
 *  - Ingresos esperados cuando exista historial suficiente.
 *  - Presupuesto restante y diferencia respecto al presupuesto inicial.
 *  - Intervalos del 95 % (Confianza de la Media vs. Predicción de Observación Futura).
 *  - Simulación de Monte Carlo (1,000 iteraciones con Bootstrap Empírico o por Bloques).
 */
import { type MontoMinor, sumarMontos } from '../dinero';
import { type EventoUniversal, type GastoPlanificadoEvento } from '../eventos';
import { diferenciaDias, finDeMes, inicioDeMes, mesDe } from '../fechas';
import {
  calcularSaldosPorCuenta,
  type CategoriaPersonalizada,
  type CuentaMetodo,
  type MovimientoFinanciero,
  type PresupuestoCategoria,
} from '../libro';
import { historialInsuficiente, type ResultadoAnalitico } from '../origen';
import { detectarAnomaliasFinancieras, type ResultadoDeteccionAnomalias } from './anomalias';
import {
  seleccionarModeloPorBacktesting,
  type ResultadoSeleccionBacktesting,
} from './backtesting';
import type { MetodoPronostico } from './estimacion';
import {
  calcularIntervalos95Proyeccion,
  type Intervalos95Proyeccion,
} from './incertidumbre';
import {
  ejecutarSimulacionMonteCarlo,
  ITERACIONES_MONTE_CARLO_DEFAULT,
  type ResultadoMonteCarloPresupuesto,
} from './montecarlo';
import {
  construirSerieTemporalDiaria,
  type DiagnosticoCalidadSerie,
} from './preparacion';

export interface ProyeccionIngresosDetalle {
  ingresoRestanteProyectadoCentimos: MontoMinor;
  ingresoTotalEsperadoCentimos: MontoMinor;
  metodoSeleccionado: MetodoPronostico;
  justificacion: string;
}

export interface ProyeccionFinDeMes {
  origen: 'PROYECTADO';
  periodoMes: string;
  fechaCorte: string;
  diasTotalesMes: number;
  diasTranscurridosMes: number;
  diasRestantesMes: number;
  /** Acumulados reales observados en el mes hasta `fechaCorte`. */
  gastosRealesAcumuladosMesCentimos: MontoMinor;
  ingresosRealesAcumuladosMesCentimos: MontoMinor;
  flujoNetoRealActualMesCentimos: MontoMinor;
  /** Gastos esperados al cierre del mes (puntual + modelo ganador del backtesting). */
  gastoRestanteProyectadoCentimos: MontoMinor;
  gastoTotalEsperadoFinDeMesCentimos: MontoMinor;
  /** Ingresos esperados cuando existe historial suficiente; de lo contrario conserva solo los ya registrados. */
  proyeccionIngresos: ResultadoAnalitico<ProyeccionIngresosDetalle>;
  ingresoTotalEsperadoFinDeMesCentimos: MontoMinor;
  /** Flujo neto proyectado al cierre del mes (Ingresos esperados - Gastos esperados). */
  flujoNetoProyectadoFinDeMesCentimos: MontoMinor;
  /** Saldo bancario proyectado al cierre (solo si todas las cuentas usadas tienen saldo inicial real). */
  saldoBancarioRealActualCentimos: MontoMinor | null;
  saldoBancarioProyectadoFinDeMesCentimos: MontoMinor | null;
  /** Presupuesto mensual configurado, presupuesto restante y diferencia vs. presupuesto inicial. */
  presupuestoInicialMesCentimos: MontoMinor | null;
  presupuestoRestanteActualCentimos: MontoMinor | null;
  presupuestoRestanteProyectadoFinDeMesCentimos: MontoMinor | null;
  /** Gasto esperado - Presupuesto inicial (> 0 indica sobrecosto proyectado; < 0 indica holgura). */
  diferenciaRespectoPresupuestoInicialCentimos: MontoMinor | null;
  /** Backtesting cronológico fuera de muestra (MCO, SES, Holt, Holt-Winters). */
  seleccionModeloGastos: ResultadoSeleccionBacktesting;
  /** Intervalos del 95 % (Confianza de la Media vs. Predicción de Observación Futura). */
  intervalosGasto95: Intervalos95Proyeccion;
  /** Simulación de Monte Carlo (1,000 iteraciones) para el mes. */
  monteCarloMensual: ResultadoAnalitico<ResultadoMonteCarloPresupuesto>;
  /** Diagnóstico de calidad y suficiencia del historial de gastos utilizado. */
  calidadDatosGastos: DiagnosticoCalidadSerie;
  notaNoEsCerteza: string;
}

export interface ProyeccionFinDeEvento {
  origen: 'PROYECTADO';
  eventoId: string;
  nombreEvento: string;
  tipoEvento: string;
  estadoEvento: EventoUniversal['estadoEvento'];
  fechaInicio: string;
  fechaFin: string;
  fechaCorte: string;
  diasTotalesEvento: number;
  diasTranscurridosEvento: number;
  diasRestantesEvento: number;
  presupuestoInicialEventoCentimos: MontoMinor;
  gastoRealAcumuladoEventoCentimos: MontoMinor;
  gastoComprometidoPendienteCentimos: MontoMinor;
  ingresoRealAcumuladoEventoCentimos: MontoMinor;
  presupuestoRestanteActualCentimos: MontoMinor;
  /** Resultado estadístico de proyección al cierre del evento (o HISTORIAL_INSUFICIENTE si el evento aún no tiene >= 7 días observados). */
  estimacionCierre: ResultadoAnalitico<{
    gastoAdicionalNoComprometidoProyectadoCentimos: MontoMinor;
    gastoTotalEsperadoFinEventoCentimos: MontoMinor;
    flujoNetoProyectadoEventoCentimos: MontoMinor;
    presupuestoRestanteProyectadoCentimos: MontoMinor;
    diferenciaRespectoPresupuestoInicialCentimos: MontoMinor;
    seleccionModelo: ResultadoSeleccionBacktesting;
    intervalos95: Intervalos95Proyeccion;
    calidadDatosEvento: DiagnosticoCalidadSerie;
  }>;
  /** Simulación de Monte Carlo de 1,000 iteraciones para el presupuesto del evento. */
  monteCarloEvento: ResultadoAnalitico<ResultadoMonteCarloPresupuesto>;
}

export interface ReportePrediccionesYRiesgo {
  generadoEnFechaCorte: string;
  periodoMes: string;
  proyeccionFinDeMes: ResultadoAnalitico<ProyeccionFinDeMes>;
  proyeccionesEventos: ProyeccionFinDeEvento[];
  anomaliasDetectadas: ResultadoAnalitico<ResultadoDeteccionAnomalias>;
}

/**
 * A. Calcula la proyección completa a fin de mes utilizando exclusivamente el historial real.
 */
export function proyectarFinDeMes(params: {
  periodoMes: string;
  fechaCorteLima: string;
  movimientos: readonly MovimientoFinanciero[];
  cuentas: readonly CuentaMetodo[];
  presupuestos: readonly PresupuestoCategoria[];
  iteracionesMonteCarlo?: number;
}): ResultadoAnalitico<ProyeccionFinDeMes> {
  const {
    periodoMes,
    fechaCorteLima,
    movimientos,
    cuentas,
    presupuestos,
    iteracionesMonteCarlo = ITERACIONES_MONTE_CARLO_DEFAULT,
  } = params;

  const baseMes = `${periodoMes}-01`;
  const inicioMes = inicioDeMes(baseMes);
  const finMes = finDeMes(baseMes);
  const diasTotalesMes = diferenciaDias(inicioMes, finMes) + 1;

  // Determinar fecha de corte efectiva dentro del mes
  let fechaCorteEfectiva = fechaCorteLima;
  let diasTranscurridosMes: number;
  let diasRestantesMes: number;

  if (fechaCorteLima > finMes) {
    // Mes histórico ya cerrado
    fechaCorteEfectiva = finMes;
    diasTranscurridosMes = diasTotalesMes;
    diasRestantesMes = 0;
  } else if (fechaCorteLima < inicioMes) {
    // Mes futuro aún no iniciado
    fechaCorteEfectiva = fechaCorteLima;
    diasTranscurridosMes = 0;
    diasRestantesMes = diasTotalesMes;
  } else {
    diasTranscurridosMes = diferenciaDias(inicioMes, fechaCorteLima) + 1;
    diasRestantesMes = diferenciaDias(fechaCorteLima, finMes);
  }

  // Movimientos reales ocurridos dentro del mes hasta la fecha de corte
  const movsMesHastaCorte = movimientos.filter(
    (m) =>
      m.estado === 'ACTIVO' &&
      mesDe(m.fechaMovimiento) === periodoMes &&
      m.fechaMovimiento <= fechaCorteEfectiva,
  );

  const gastosRealesAcumuladosMesCentimos = sumarMontos(
    movsMesHastaCorte
      .filter((m) => m.tipo === 'GASTO')
      .map((m) => m.montoCentimos),
  );
  const ingresosRealesAcumuladosMesCentimos = sumarMontos(
    movsMesHastaCorte
      .filter((m) => m.tipo === 'INGRESO')
      .map((m) => m.montoCentimos),
  );
  const flujoNetoRealActualMesCentimos = sumarMontos([
    ingresosRealesAcumuladosMesCentimos,
    -gastosRealesAcumuladosMesCentimos,
  ]);

  // Construir serie temporal histórica real de gastos hasta `fechaCorteEfectiva`
  const serieGastos = construirSerieTemporalDiaria({
    movimientos,
    tipo: 'GASTO',
    hastaForzado: fechaCorteEfectiva,
  });

  if (!serieGastos || !serieGastos.diagnostico.aptoModelosBasicos) {
    const disp = serieGastos ? serieGastos.diagnostico.totalDiasObservados : 0;
    const activos = serieGastos ? serieGastos.diagnostico.diasConActividad : 0;
    return historialInsuficiente(
      7,
      disp,
      `días de cobertura histórica real con al menos 3 días con gastos (disponibles: ${disp} días de cobertura y ${activos} día(s) con gasto)`,
      `proyectar el cierre del mes ${periodoMes}`,
    );
  }

  // Seleccionar el mejor método de pronóstico mediante Backtesting Walk-Forward fuera de muestra
  const seleccionModeloGastos = seleccionarModeloPorBacktesting(
    serieGastos.valoresCentimos,
    serieGastos.diagnostico.aptoHoltWintersSemanal,
  );

  const pronosticosDiariosRestantes =
    diasRestantesMes > 0
      ? seleccionModeloGastos.modeloFinalReentrenado.pronosticar(diasRestantesMes)
      : [];
  const gastoRestanteProyectadoCentimos = Math.round(
    pronosticosDiariosRestantes.reduce((a, b) => a + b, 0),
  );
  const gastoTotalEsperadoFinDeMesCentimos = sumarMontos([
    gastosRealesAcumuladosMesCentimos,
    gastoRestanteProyectadoCentimos,
  ]);

  // Intervalos del 95 % (Confianza de la media vs. Predicción de observación futura)
  const intervalosGasto95 = calcularIntervalos95Proyeccion({
    acumuladoRealActualCentimos: gastosRealesAcumuladosMesCentimos,
    pronosticoRestanteCentimos: gastoRestanteProyectadoCentimos,
    horizonteDias: diasRestantesMes,
    serieObservada: serieGastos.valoresCentimos,
    residuosInSample: seleccionModeloGastos.modeloFinalReentrenado.residuosInSample,
    erroresOutSample: seleccionModeloGastos.erroresOutSampleGanador,
    parametrosModelo: seleccionModeloGastos.modeloFinalReentrenado.parametros,
  });

  // Proyección de ingresos (cuando exista historial suficiente de ingresos: >= 14 días de cobertura y >= 3 días con ingresos)
  const serieIngresos = construirSerieTemporalDiaria({
    movimientos,
    tipo: 'INGRESO',
    hastaForzado: fechaCorteEfectiva,
  });

  let proyeccionIngresos: ResultadoAnalitico<ProyeccionIngresosDetalle>;
  let ingresoTotalEsperadoFinDeMesCentimos = ingresosRealesAcumuladosMesCentimos;

  if (
    serieIngresos &&
    serieIngresos.diagnostico.totalDiasObservados >= 14 &&
    serieIngresos.diagnostico.diasConActividad >= 3
  ) {
    const selIngresos = seleccionarModeloPorBacktesting(
      serieIngresos.valoresCentimos,
      serieIngresos.diagnostico.aptoHoltWintersSemanal,
    );
    const predIngRest =
      diasRestantesMes > 0
        ? Math.round(
            selIngresos.modeloFinalReentrenado
              .pronosticar(diasRestantesMes)
              .reduce((a, b) => a + b, 0),
          )
        : 0;
    ingresoTotalEsperadoFinDeMesCentimos = sumarMontos([
      ingresosRealesAcumuladosMesCentimos,
      predIngRest,
    ]);
    proyeccionIngresos = {
      estado: 'OK',
      origen: 'PROYECTADO',
      metodo: selIngresos.metodoSeleccionado,
      ventana: {
        desde: serieIngresos.desde,
        hasta: serieIngresos.hasta,
        observaciones: serieIngresos.diagnostico.totalDiasObservados,
      },
      datos: {
        ingresoRestanteProyectadoCentimos: predIngRest,
        ingresoTotalEsperadoCentimos: ingresoTotalEsperadoFinDeMesCentimos,
        metodoSeleccionado: selIngresos.metodoSeleccionado,
        justificacion: selIngresos.justificacionSeleccion,
      },
    };
  } else {
    const dispIng = serieIngresos ? serieIngresos.diagnostico.diasConActividad : 0;
    proyeccionIngresos = historialInsuficiente(
      3,
      dispIng,
      'registros de ingreso en al menos 14 días de cobertura (se mantiene únicamente el ingreso real ya registrado en el mes sin extrapolar nuevos ingresos)',
      'proyectar ingresos adicionales del mes',
    );
  }

  const flujoNetoProyectadoFinDeMesCentimos = sumarMontos([
    ingresoTotalEsperadoFinDeMesCentimos,
    -gastoTotalEsperadoFinDeMesCentimos,
  ]);

  // Verificar saldo bancario real (solo si hay cuentas activas y todas cuentan con SALDO_INICIAL real)
  const saldosPorCuenta = calcularSaldosPorCuenta(cuentas, movimientos);
  const todasConSaldoInicial =
    saldosPorCuenta.length > 0 &&
    saldosPorCuenta.every((s) => s.estadoSaldo === 'SALDO_REAL_COMPLETO');
  const saldoBancarioRealActualCentimos = todasConSaldoInicial
    ? sumarMontos(saldosPorCuenta.map((s) => s.saldoBancarioRealCentimos ?? 0))
    : null;
  const ingresoRestanteEstimado =
    ingresoTotalEsperadoFinDeMesCentimos - ingresosRealesAcumuladosMesCentimos;
  const saldoBancarioProyectadoFinDeMesCentimos =
    saldoBancarioRealActualCentimos !== null
      ? sumarMontos([
          saldoBancarioRealActualCentimos,
          ingresoRestanteEstimado,
          -gastoRestanteProyectadoCentimos,
        ])
      : null;

  // Presupuestos del mes
  const presupuestosMes = presupuestos.filter(
    (p) => p.estado === 'ACTIVO' && p.periodoMes === periodoMes,
  );
  const presupuestoInicialMesCentimos =
    presupuestosMes.length > 0
      ? sumarMontos(presupuestosMes.map((p) => p.limiteCentimos))
      : null;

  const presupuestoRestanteActualCentimos =
    presupuestoInicialMesCentimos !== null
      ? presupuestoInicialMesCentimos - gastosRealesAcumuladosMesCentimos
      : null;
  const presupuestoRestanteProyectadoFinDeMesCentimos =
    presupuestoInicialMesCentimos !== null
      ? presupuestoInicialMesCentimos - gastoTotalEsperadoFinDeMesCentimos
      : null;
  const diferenciaRespectoPresupuestoInicialCentimos =
    presupuestoInicialMesCentimos !== null
      ? gastoTotalEsperadoFinDeMesCentimos - presupuestoInicialMesCentimos
      : null;

  // Simulación de Monte Carlo (1,000 iteraciones)
  const monteCarloMensual = ejecutarSimulacionMonteCarlo({
    serieGastos,
    gastoAcumuladoActualCentimos: gastosRealesAcumuladosMesCentimos,
    horizonteDiasRestantes: diasRestantesMes,
    presupuestoObjetivoCentimos: presupuestoInicialMesCentimos,
    iteraciones: iteracionesMonteCarlo,
    contextoNombre: `el presupuesto mensual de ${periodoMes}`,
  });

  return {
    estado: 'OK',
    origen: 'PROYECTADO',
    metodo: seleccionModeloGastos.metodoSeleccionado,
    ventana: {
      desde: serieGastos.desde,
      hasta: serieGastos.hasta,
      observaciones: serieGastos.diagnostico.totalDiasObservados,
    },
    datos: {
      origen: 'PROYECTADO',
      periodoMes,
      fechaCorte: fechaCorteEfectiva,
      diasTotalesMes,
      diasTranscurridosMes,
      diasRestantesMes,
      gastosRealesAcumuladosMesCentimos,
      ingresosRealesAcumuladosMesCentimos,
      flujoNetoRealActualMesCentimos,
      gastoRestanteProyectadoCentimos,
      gastoTotalEsperadoFinDeMesCentimos,
      proyeccionIngresos,
      ingresoTotalEsperadoFinDeMesCentimos,
      flujoNetoProyectadoFinDeMesCentimos,
      saldoBancarioRealActualCentimos,
      saldoBancarioProyectadoFinDeMesCentimos,
      presupuestoInicialMesCentimos,
      presupuestoRestanteActualCentimos,
      presupuestoRestanteProyectadoFinDeMesCentimos,
      diferenciaRespectoPresupuestoInicialCentimos,
      seleccionModeloGastos,
      intervalosGasto95,
      monteCarloMensual,
      calidadDatosGastos: serieGastos.diagnostico,
      notaNoEsCerteza:
        'Toda proyección es una estimación estadística sujeta a incertidumbre (origen PROYECTADO). Consulte el Intervalo de Predicción del 95 % y los escenarios de Monte Carlo en lugar de tomar el valor puntual como certeza.',
    },
  };
}

/**
 * B. Calcula la proyección a fin de un evento universal.
 */
export function proyectarFinDeEvento(params: {
  evento: EventoUniversal;
  fechaCorteLima: string;
  movimientos: readonly MovimientoFinanciero[];
  gastosPlanificados: readonly GastoPlanificadoEvento[];
  iteracionesMonteCarlo?: number;
}): ProyeccionFinDeEvento {
  const {
    evento,
    fechaCorteLima,
    movimientos,
    gastosPlanificados,
    iteracionesMonteCarlo = ITERACIONES_MONTE_CARLO_DEFAULT,
  } = params;

  const diasTotalesEvento = Math.max(
    1,
    diferenciaDias(evento.fechaInicio, evento.fechaFin) + 1,
  );

  let fechaCorteEfectiva = fechaCorteLima;
  let diasTranscurridosEvento: number;
  let diasRestantesEvento: number;

  if (evento.estadoEvento === 'FINALIZADO' || fechaCorteLima > evento.fechaFin) {
    fechaCorteEfectiva = evento.fechaFin;
    diasTranscurridosEvento = diasTotalesEvento;
    diasRestantesEvento = 0;
  } else if (fechaCorteLima < evento.fechaInicio) {
    fechaCorteEfectiva = fechaCorteLima;
    diasTranscurridosEvento = 0;
    diasRestantesEvento = diasTotalesEvento;
  } else {
    diasTranscurridosEvento = diferenciaDias(evento.fechaInicio, fechaCorteLima) + 1;
    diasRestantesEvento = diferenciaDias(fechaCorteLima, evento.fechaFin);
  }

  const movsEvento = movimientos.filter(
    (m) => m.estado === 'ACTIVO' && m.eventoId === evento.id,
  );
  const gastoRealAcumuladoEventoCentimos = sumarMontos(
    movsEvento.filter((m) => m.tipo === 'GASTO').map((m) => m.montoCentimos),
  );
  const ingresoRealAcumuladoEventoCentimos = sumarMontos(
    movsEvento.filter((m) => m.tipo === 'INGRESO').map((m) => m.montoCentimos),
  );

  // Gastos comprometidos aún no convertidos en movimiento real
  const gastoComprometidoPendienteCentimos = sumarMontos(
    gastosPlanificados
      .filter(
        (gp) =>
          gp.estado === 'ACTIVO' &&
          gp.eventoId === evento.id &&
          gp.estadoPlanificacion === 'COMPROMETIDO' &&
          gp.movimientoRealId === null,
      )
      .map((gp) => gp.montoEstimadoCentimos),
  );

  const presupuestoInicial = evento.presupuestoTotalCentimos;
  const presupuestoRestanteActualCentimos =
    presupuestoInicial -
    gastoRealAcumuladoEventoCentimos -
    gastoComprometidoPendienteCentimos;

  const serieGastosEvento = construirSerieTemporalDiaria({
    movimientos: movsEvento,
    tipo: 'GASTO',
    desdeForzado: evento.fechaInicio,
    hastaForzado:
      fechaCorteEfectiva >= evento.fechaInicio ? fechaCorteEfectiva : undefined,
  });

  if (!serieGastosEvento || !serieGastosEvento.diagnostico.aptoModelosBasicos) {
    const disp = serieGastosEvento
      ? serieGastosEvento.diagnostico.totalDiasObservados
      : 0;
    const act = serieGastosEvento
      ? serieGastosEvento.diagnostico.diasConActividad
      : 0;

    const insuf = historialInsuficiente(
      7,
      disp,
      `días observados en el evento "${evento.nombre}" con al menos 3 días de gasto real (actualmente ${disp} día(s) observados y ${act} día(s) con gasto)`,
      `proyectar estadísticamente el cierre del evento "${evento.nombre}"`,
    );

    return {
      origen: 'PROYECTADO',
      eventoId: evento.id,
      nombreEvento: evento.nombre,
      tipoEvento: evento.tipoEvento,
      estadoEvento: evento.estadoEvento,
      fechaInicio: evento.fechaInicio,
      fechaFin: evento.fechaFin,
      fechaCorte: fechaCorteEfectiva,
      diasTotalesEvento,
      diasTranscurridosEvento,
      diasRestantesEvento,
      presupuestoInicialEventoCentimos: presupuestoInicial,
      gastoRealAcumuladoEventoCentimos,
      gastoComprometidoPendienteCentimos,
      ingresoRealAcumuladoEventoCentimos,
      presupuestoRestanteActualCentimos,
      estimacionCierre: insuf,
      monteCarloEvento: historialInsuficiente(
        7,
        disp,
        `días observados en el evento "${evento.nombre}" con al menos 3 días de gasto real`,
        `ejecutar simulación Monte Carlo del evento "${evento.nombre}"`,
      ),
    };
  }

  const seleccionModelo = seleccionarModeloPorBacktesting(
    serieGastosEvento.valoresCentimos,
    serieGastosEvento.diagnostico.aptoHoltWintersSemanal,
  );

  const predRestante =
    diasRestantesEvento > 0
      ? Math.round(
          seleccionModelo.modeloFinalReentrenado
            .pronosticar(diasRestantesEvento)
            .reduce((a, b) => a + b, 0),
        )
      : 0;

  const baseConocida = sumarMontos([
    gastoRealAcumuladoEventoCentimos,
    gastoComprometidoPendienteCentimos,
  ]);
  const gastoTotalEsperadoFinEventoCentimos = sumarMontos([
    baseConocida,
    predRestante,
  ]);
  const flujoNetoProyectadoEventoCentimos = sumarMontos([
    ingresoRealAcumuladoEventoCentimos,
    -gastoTotalEsperadoFinEventoCentimos,
  ]);
  const presupuestoRestanteProyectadoCentimos =
    presupuestoInicial - gastoTotalEsperadoFinEventoCentimos;
  const diferenciaRespectoPresupuestoInicialCentimos =
    gastoTotalEsperadoFinEventoCentimos - presupuestoInicial;

  const intervalos95 = calcularIntervalos95Proyeccion({
    acumuladoRealActualCentimos: baseConocida,
    pronosticoRestanteCentimos: predRestante,
    horizonteDias: diasRestantesEvento,
    serieObservada: serieGastosEvento.valoresCentimos,
    residuosInSample: seleccionModelo.modeloFinalReentrenado.residuosInSample,
    erroresOutSample: seleccionModelo.erroresOutSampleGanador,
    parametrosModelo: seleccionModelo.modeloFinalReentrenado.parametros,
  });

  const monteCarloEvento = ejecutarSimulacionMonteCarlo({
    serieGastos: serieGastosEvento,
    gastoAcumuladoActualCentimos: gastoRealAcumuladoEventoCentimos,
    comprometidoAdicionalCentimos: gastoComprometidoPendienteCentimos,
    horizonteDiasRestantes: diasRestantesEvento,
    presupuestoObjetivoCentimos:
      presupuestoInicial > 0 ? presupuestoInicial : null,
    iteraciones: iteracionesMonteCarlo,
    contextoNombre: `el evento "${evento.nombre}"`,
  });

  return {
    origen: 'PROYECTADO',
    eventoId: evento.id,
    nombreEvento: evento.nombre,
    tipoEvento: evento.tipoEvento,
    estadoEvento: evento.estadoEvento,
    fechaInicio: evento.fechaInicio,
    fechaFin: evento.fechaFin,
    fechaCorte: fechaCorteEfectiva,
    diasTotalesEvento,
    diasTranscurridosEvento,
    diasRestantesEvento,
    presupuestoInicialEventoCentimos: presupuestoInicial,
    gastoRealAcumuladoEventoCentimos,
    gastoComprometidoPendienteCentimos,
    ingresoRealAcumuladoEventoCentimos,
    presupuestoRestanteActualCentimos,
    estimacionCierre: {
      estado: 'OK',
      origen: 'PROYECTADO',
      metodo: seleccionModelo.metodoSeleccionado,
      ventana: {
        desde: serieGastosEvento.desde,
        hasta: serieGastosEvento.hasta,
        observaciones: serieGastosEvento.diagnostico.totalDiasObservados,
      },
      datos: {
        gastoAdicionalNoComprometidoProyectadoCentimos: predRestante,
        gastoTotalEsperadoFinEventoCentimos,
        flujoNetoProyectadoEventoCentimos,
        presupuestoRestanteProyectadoCentimos,
        diferenciaRespectoPresupuestoInicialCentimos,
        seleccionModelo,
        intervalos95,
        calidadDatosEvento: serieGastosEvento.diagnostico,
      },
    },
    monteCarloEvento,
  };
}

/**
 * Ejecuta el motor completo de Predicciones y Riesgo Financiero (Fin de Mes, Eventos,
 * Intervalos 95%, Monte Carlo y Detección de Anomalías).
 */
export function ejecutarMotorPrediccionesYRiesgo(params: {
  periodoMes: string;
  fechaCorteLima: string;
  movimientos: readonly MovimientoFinanciero[];
  cuentas: readonly CuentaMetodo[];
  categorias: readonly CategoriaPersonalizada[];
  presupuestos: readonly PresupuestoCategoria[];
  eventos: readonly EventoUniversal[];
  gastosPlanificados: readonly GastoPlanificadoEvento[];
  umbralZAnomalias?: number;
  iteracionesMonteCarlo?: number;
}): ReportePrediccionesYRiesgo {
  const proyeccionFinDeMes = proyectarFinDeMes({
    periodoMes: params.periodoMes,
    fechaCorteLima: params.fechaCorteLima,
    movimientos: params.movimientos,
    cuentas: params.cuentas,
    presupuestos: params.presupuestos,
    iteracionesMonteCarlo: params.iteracionesMonteCarlo,
  });

  const eventosActivos = params.eventos.filter(
    (e) => e.estado === 'ACTIVO' && e.estadoEvento !== 'CANCELADO',
  );
  const proyeccionesEventos = eventosActivos.map((evento) =>
    proyectarFinDeEvento({
      evento,
      fechaCorteLima: params.fechaCorteLima,
      movimientos: params.movimientos,
      gastosPlanificados: params.gastosPlanificados,
      iteracionesMonteCarlo: params.iteracionesMonteCarlo,
    }),
  );

  const anomaliasDetectadas = detectarAnomaliasFinancieras({
    movimientos: params.movimientos,
    categorias: params.categorias,
    umbralZ: params.umbralZAnomalias,
    periodoMesFoco: params.periodoMes,
  });

  return {
    generadoEnFechaCorte: params.fechaCorteLima,
    periodoMes: params.periodoMes,
    proyeccionFinDeMes,
    proyeccionesEventos,
    anomaliasDetectadas,
  };
}
