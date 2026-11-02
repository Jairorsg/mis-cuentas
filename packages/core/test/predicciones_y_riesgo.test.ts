import { describe, expect, it } from 'vitest';
import {
  ajustarHolt,
  ajustarHoltWintersAditivo,
  ajustarMCO,
  ajustarSES,
  CachePrediccionesFinancieras,
  calcularIntervalos95Proyeccion,
  construirSerieTemporalDiaria,
  detectarAnomaliasFinancieras,
  ejecutarSimulacionMonteCarlo,
  proyectarFinDeEvento,
  proyectarFinDeMes,
  seleccionarModeloPorBacktesting,
  sumarDias,
  type CategoriaPersonalizada,
  type CuentaMetodo,
  type EventoUniversal,
  type MovimientoFinanciero,
  type PresupuestoCategoria,
} from '../src/index';

const AUDITORIA_BASE = {
  origen: 'MANUAL' as const,
  creadoEn: '2026-03-01T12:00:00.000Z',
  actualizadoEn: '2026-03-01T12:00:00.000Z',
  eliminadoEn: null,
  version: 1,
  loteImportacionId: null,
};

const CATEGORIAS: CategoriaPersonalizada[] = [
  {
    id: 'cat-alim',
    nombre: 'Alimentación',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-sueldo',
    nombre: 'Sueldo',
    naturaleza: 'INGRESO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
];

const CUENTAS: CuentaMetodo[] = [
  {
    id: 'cta-1',
    nombre: 'Efectivo PEN',
    tipo: 'EFECTIVO',
    moneda: 'PEN',
    institucion: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
];

function movPrueba(params: {
  id: string;
  fecha: string;
  montoCentimos: number;
  tipo?: 'GASTO' | 'INGRESO' | 'SALDO_INICIAL';
  categoriaId?: string | null;
  eventoId?: string | null;
  descripcion?: string;
}): MovimientoFinanciero {
  return {
    id: params.id,
    fechaMovimiento: params.fecha,
    horaMovimiento: '13:00',
    registradoEn: `${params.fecha}T18:00:00.000Z`,
    tipo: params.tipo ?? 'GASTO',
    categoriaId:
      params.tipo === 'SALDO_INICIAL'
        ? null
        : (params.categoriaId ?? (params.tipo === 'INGRESO' ? 'cat-sueldo' : 'cat-alim')),
    subcategoriaId: null,
    cuentaId: 'cta-1',
    cuentaDestinoId: null,
    esPagoTarjeta: false,
    montoCentimos: params.montoCentimos,
    moneda: 'PEN',
    etiquetas: [],
    descripcion: params.descripcion ?? null,
    eventoId: params.eventoId ?? null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  };
}

describe('Fase 4: Motor Estadístico de Predicciones y Riesgo Financiero', () => {
  it('1. Diferencia matemáticamente MCO, SES (nivel plano), Holt (tendencia lineal) y Holt-Winters (estacionalidad semanal m=7)', () => {
    // Serie con tendencia creciente lineal exacta: 1000, 1200, 1400, ..., 3000 (11 puntos)
    const serieTendencia = Array.from({ length: 11 }, (_, i) => 1000 + i * 200);

    const modMCO = ajustarMCO(serieTendencia);
    const modSES = ajustarSES(serieTendencia);
    const modHolt = ajustarHolt(serieTendencia);

    const predMCO = modMCO.pronosticar(4);
    const predSES = modSES.pronosticar(4);
    const predHolt = modHolt.pronosticar(4);

    // SES pronostica un nivel constante (sin pendiente): predSES[0] === predSES[3]
    expect(predSES[0]).toBeCloseTo(predSES[3]!, 5);

    // MCO y Holt proyectan la tendencia creciente: horizonte h=4 > h=1
    expect(predMCO[3]!).toBeGreaterThan(predMCO[0]!);
    expect(Math.round(predMCO[0]!)).toBe(3200);
    expect(Math.round(predMCO[3]!)).toBe(3800);
    expect(predHolt[3]!).toBeGreaterThan(predHolt[0]!);

    // Holt-Winters requiere al menos 2 ciclos completos (14 días para m=7)
    expect(() => ajustarHoltWintersAditivo(serieTendencia, 7)).toThrow();

    // Serie de 21 días con fuerte estacionalidad semanal (Sábado y Domingo gastan 8000, Lunes-Viernes 2000)
    const patronSemanal = [2000, 2000, 2000, 2000, 2000, 8000, 8000];
    const serieEstacional21 = [
      ...patronSemanal,
      ...patronSemanal,
      ...patronSemanal,
    ];
    const modHW = ajustarHoltWintersAditivo(serieEstacional21, 7);
    const predHW7 = modHW.pronosticar(7);

    // Los días 6 y 7 del pronóstico (fin de semana) deben ser sustancialmente mayores que los días 1..5
    expect(predHW7[5]!).toBeGreaterThan(predHW7[0]! * 2);
    expect(predHW7[6]!).toBeGreaterThan(predHW7[1]! * 2);
  });

  it('2. Backtesting walk-forward fuera de muestra: respeta el orden cronológico, omite Holt-Winters cuando N < 21 y selecciona el modelo de menor RMSE', () => {
    // Serie corta (10 días): Holt-Winters debe omitirse por historial insuficiente, evaluándose MCO, SES y Holt
    const serie10 = [2500, 2600, 2400, 2550, 2480, 2520, 2490, 2510, 2500, 2505];
    const btCorto = seleccionarModeloPorBacktesting(serie10, false);
    expect(btCorto.particionCronologicaEstricta).toBe(true);
    const evalHW = btCorto.comparativaModelos.find((m) => m.metodo === 'HOLT_WINTERS')!;
    expect(evalHW.evaluado).toBe(false);

    // Serie de 28 días con patrón estacional semanal marcado -> Holt-Winters debe ser evaluado y ganar por menor RMSE fuera de muestra
    const patron = [1500, 1600, 1500, 1550, 1650, 9000, 8500];
    const serie28 = [...patron, ...patron, ...patron, ...patron];
    const btEstacional = seleccionarModeloPorBacktesting(serie28, true);
    const hwEval28 = btEstacional.comparativaModelos.find((m) => m.metodo === 'HOLT_WINTERS')!;
    const sesEval28 = btEstacional.comparativaModelos.find((m) => m.metodo === 'SES')!;

    expect(hwEval28.evaluado).toBe(true);
    expect(hwEval28.rmseOutSampleCentimos!).toBeLessThan(sesEval28.rmseOutSampleCentimos!);
    expect(btEstacional.metodoSeleccionado).toBe('HOLT_WINTERS');
  });

  it('3. Incertidumbre: diferencia el Intervalo de Confianza de la Media (95%) del Intervalo de Predicción de Observación Futura (95%) y detecta cambios recientes', () => {
    // Primeros 7 días alrededor de 2000, últimos 4 días suben a 5000 (cambio de comportamiento > 35%)
    const serie = [2000, 2100, 1900, 2050, 1950, 2000, 2100, 4800, 5200, 5000, 5100];
    const bt = seleccionarModeloPorBacktesting(serie, false);

    const intervalos = calcularIntervalos95Proyeccion({
      acumuladoRealActualCentimos: 32_200,
      pronosticoRestanteCentimos: 25_000,
      horizonteDias: 5,
      serieObservada: serie,
      residuosInSample: bt.modeloFinalReentrenado.residuosInSample,
      erroresOutSample: bt.erroresOutSampleGanador,
      parametrosModelo: bt.modeloFinalReentrenado.parametros,
    });

    const anchoMedia =
      intervalos.intervaloConfianzaMedia95.superiorCentimos -
      intervalos.intervaloConfianzaMedia95.inferiorCentimos;
    const anchoPrediccion =
      intervalos.intervaloPrediccionObservacion95.superiorCentimos -
      intervalos.intervaloPrediccionObservacion95.inferiorCentimos;

    // El intervalo de predicción de una realización futura SIEMPRE debe ser más amplio que el IC de la media esperada
    expect(anchoPrediccion).toBeGreaterThan(anchoMedia);
    expect(intervalos.diagnosticoResiduos.cambioComportamientoReciente).toBe(true);
  });

  it('4. Monte Carlo (1,000 iteraciones): rechaza muestras insuficientes sin fabricar probabilidades y ejecuta Bootstrap empírico / por bloques sobre datos reales', () => {
    // Historial insuficiente: solo 3 días
    const movsInsuf = [
      movPrueba({ id: 'm1', fecha: '2026-03-01', montoCentimos: 2000 }),
      movPrueba({ id: 'm2', fecha: '2026-03-02', montoCentimos: 2500 }),
    ];
    const serieInsuf = construirSerieTemporalDiaria({
      movimientos: movsInsuf,
      tipo: 'GASTO',
    });
    const mcInsuf = ejecutarSimulacionMonteCarlo({
      serieGastos: serieInsuf,
      gastoAcumuladoActualCentimos: 4500,
      horizonteDiasRestantes: 10,
      presupuestoObjetivoCentimos: 30_000,
    });
    expect(mcInsuf.estado).toBe('HISTORIAL_INSUFICIENTE');

    // Historial real de 21 días con gastos diarios entre S/ 30.00 y S/ 60.00
    const movs21: MovimientoFinanciero[] = [];
    for (let i = 0; i < 21; i++) {
      const fecha = sumarDias('2026-03-01', i);
      const monto = i % 7 >= 5 ? 6000 : 3000;
      movs21.push(movPrueba({ id: `mc-${i}`, fecha, montoCentimos: monto }));
    }
    const serie21 = construirSerieTemporalDiaria({
      movimientos: movs21,
      tipo: 'GASTO',
    });
    const acumulado21 = serie21!.sumaTotalCentimos; // 15 * 3000 + 6 * 6000 = 81_000

    const mcOk = ejecutarSimulacionMonteCarlo({
      serieGastos: serie21,
      gastoAcumuladoActualCentimos: acumulado21,
      horizonteDiasRestantes: 10,
      presupuestoObjetivoCentimos: 115_000,
      iteraciones: 1000,
    });

    expect(mcOk.estado).toBe('OK');
    if (mcOk.estado !== 'OK') return;

    expect(mcOk.datos.origen).toBe('PROYECTADO');
    expect(mcOk.datos.numeroSimulaciones).toBe(1000);
    expect(mcOk.datos.numeroObservaciones).toBe(21);
    expect(mcOk.datos.metodoUtilizado).toBe('BOOTSTRAP_BLOQUES_MOVILES');
    expect(mcOk.datos.longitudBloqueDias).toBe(7);

    // Orden coherente de percentiles empíricos
    expect(mcOk.datos.percentil2_5Centimos).toBeLessThanOrEqual(
      mcOk.datos.escenarioFavorableP10Centimos,
    );
    expect(mcOk.datos.escenarioFavorableP10Centimos).toBeLessThanOrEqual(
      mcOk.datos.escenarioCentralMedianaCentimos,
    );
    expect(mcOk.datos.escenarioCentralMedianaCentimos).toBeLessThanOrEqual(
      mcOk.datos.escenarioDesfavorableP90Centimos,
    );
    expect(mcOk.datos.escenarioDesfavorableP90Centimos).toBeLessThanOrEqual(
      mcOk.datos.percentil97_5Centimos,
    );
    expect(mcOk.datos.probabilidadSuperarPresupuesto).not.toBeNull();
    expect(mcOk.datos.probabilidadSuperarPresupuesto!).toBeGreaterThanOrEqual(0);
    expect(mcOk.datos.probabilidadSuperarPresupuesto!).toBeLessThanOrEqual(1);
  });

  it('5. Detección de Anomalías: calcula Z-score clásico y Z-score robusto (Mediana y MAD) con umbral Z > 2 y distingue alerta estadística de fraude', () => {
    // 8 gastos habituales alrededor de S/ 25.00 y 1 gasto atípico de S/ 480.00 en la misma categoría
    const montos = [2400, 2500, 2600, 2450, 2550, 2500, 2350, 2650, 48_000];
    const movs = montos.map((m, idx) =>
      movPrueba({
        id: `an-${idx}`,
        fecha: sumarDias('2026-03-01', idx),
        montoCentimos: m,
        categoriaId: 'cat-alim',
        descripcion: idx === 8 ? 'Compra extraordinaria' : 'Almuerzo',
      }),
    );

    const det = detectarAnomaliasFinancieras({
      movimientos: movs,
      categorias: CATEGORIAS,
      umbralZ: 2.0,
    });

    expect(det.estado).toBe('OK');
    if (det.estado !== 'OK') return;

    const alertaElevada = det.datos.alertas.find(
      (a) => a.movimientoId === 'an-8' && a.tipoAlerta === 'GASTO_INUSUALMENTE_ELEVADO',
    );
    expect(alertaElevada).toBeDefined();
    expect(alertaElevada!.ambitoComparacion).toBe('CATEGORIA');
    expect(alertaElevada!.zScoreClasico).toBeGreaterThan(2.0);
    expect(alertaElevada!.zScoreRobustoMad).toBeGreaterThan(10.0);
    expect(alertaElevada!.notaNoEsFraude).toContain('no implica fraude');
  });

  it('6. Proyección de Fin de Mes, Fin de Evento y Caché determinista con invalidación al cambiar transacciones', () => {
    const movimientos: MovimientoFinanciero[] = [
      movPrueba({
        id: 'sal-ini',
        fecha: '2026-03-01',
        montoCentimos: 500_000,
        tipo: 'SALDO_INICIAL',
      }),
      movPrueba({
        id: 'ing-1',
        fecha: '2026-03-01',
        montoCentimos: 400_000,
        tipo: 'INGRESO',
      }),
    ];

    const eventoViaje: EventoUniversal = {
      id: 'ev-1',
      nombre: 'Expedición Arequipa',
      tipoEvento: 'VIAJE',
      fechaInicio: '2026-03-05',
      fechaFin: '2026-03-20',
      ubicacion: 'Arequipa',
      presupuestoTotalCentimos: 150_000,
      moneda: 'PEN',
      partidasPresupuesto: [],
      participantes: [],
      etiquetas: ['#Viaje'],
      descripcion: null,
      estadoEvento: 'ACTIVO',
      estado: 'ACTIVO',
      auditoria: AUDITORIA_BASE,
    };

    // Agregar 10 días de gastos (del 2026-03-05 al 2026-03-14) vinculados al evento
    for (let i = 0; i < 10; i++) {
      movimientos.push(
        movPrueba({
          id: `g-ev-${i}`,
          fecha: sumarDias('2026-03-05', i),
          montoCentimos: 8_000 + (i % 3) * 1_000,
          eventoId: 'ev-1',
        }),
      );
    }

    const presupuestos: PresupuestoCategoria[] = [
      {
        id: 'pres-marzo',
        categoriaId: 'cat-alim',
        periodoMes: '2026-03',
        limiteCentimos: 250_000,
        estado: 'ACTIVO',
        auditoria: AUDITORIA_BASE,
      },
    ];

    const proyMes = proyectarFinDeMes({
      periodoMes: '2026-03',
      fechaCorteLima: '2026-03-14',
      movimientos,
      cuentas: CUENTAS,
      presupuestos,
    });
    expect(proyMes.estado).toBe('OK');
    if (proyMes.estado === 'OK') {
      expect(proyMes.datos.diasTotalesMes).toBe(31);
      expect(proyMes.datos.diasTranscurridosMes).toBe(14);
      expect(proyMes.datos.diasRestantesMes).toBe(17);
      expect(proyMes.datos.gastoTotalEsperadoFinDeMesCentimos).toBeGreaterThan(
        proyMes.datos.gastosRealesAcumuladosMesCentimos,
      );
      expect(proyMes.datos.saldoBancarioProyectadoFinDeMesCentimos).not.toBeNull();
      expect(proyMes.datos.presupuestoInicialMesCentimos).toBe(250_000);
    }

    const proyEv = proyectarFinDeEvento({
      evento: eventoViaje,
      fechaCorteLima: '2026-03-14',
      movimientos,
      gastosPlanificados: [],
    });
    expect(proyEv.estimacionCierre.estado).toBe('OK');
    expect(proyEv.monteCarloEvento.estado).toBe('OK');

    // Verificar Caché determinista e invalidación automática
    const cache = new CachePrediccionesFinancieras();
    const r1 = cache.obtenerOCalcular({
      periodoMes: '2026-03',
      fechaCorteLima: '2026-03-14',
      movimientos,
      cuentas: CUENTAS,
      categorias: CATEGORIAS,
      presupuestos,
      eventos: [eventoViaje],
      gastosPlanificados: [],
    });
    expect(r1.desdeCache).toBe(false);
    expect(r1.estadisticasCache.ejecucionesReales).toBe(1);

    // Segunda llamada sin cambios -> se sirve desde caché sin re-ejecutar modelos
    const r2 = cache.obtenerOCalcular({
      periodoMes: '2026-03',
      fechaCorteLima: '2026-03-14',
      movimientos,
      cuentas: CUENTAS,
      categorias: CATEGORIAS,
      presupuestos,
      eventos: [eventoViaje],
      gastosPlanificados: [],
    });
    expect(r2.desdeCache).toBe(true);
    expect(r2.estadisticasCache.ejecucionesReales).toBe(1);
    expect(r2.estadisticasCache.aciertosCache).toBe(1);

    // Al agregar una nueva transacción, la huella cambia y el caché se invalida automáticamente
    const r3 = cache.obtenerOCalcular({
      periodoMes: '2026-03',
      fechaCorteLima: '2026-03-14',
      movimientos: [
        ...movimientos,
        movPrueba({ id: 'g-nuevo', fecha: '2026-03-14', montoCentimos: 5_000 }),
      ],
      cuentas: CUENTAS,
      categorias: CATEGORIAS,
      presupuestos,
      eventos: [eventoViaje],
      gastosPlanificados: [],
    });
    expect(r3.desdeCache).toBe(false);
    expect(r3.estadisticasCache.ejecucionesReales).toBe(2);
  });
});
