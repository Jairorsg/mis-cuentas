/**
 * Módulo de Analítica Financiera Avanzada (Fase 3).
 *
 * Implementa cálculos 100% deterministas y derivados de los movimientos reales:
 *  1. Waterfall Chart con partición mutuamente excluyente:
 *     Ingresos - Gastos fijos - Gastos variables - Gastos asociados a eventos = Flujo neto.
 *  2. Heatmap Temporal 24x7 (horas del día x días de la semana en America/Lima)
 *     con frecuencia, importe gastado e importe promedio por operación.
 *  3. Curva de Liquidez y Desviación diaria:
 *     Flujo acumulado real, gasto diario, gasto acumulado esperado E[S(t)] = t * μ
 *     y bandas descriptivas ±1σ y ±2σ con σ_acum(t) = σ * sqrt(t).
 *  4. Diagrama de Pareto 80/20 por categoría de gasto real.
 */
import { dividirMitadPar, type MontoMinor, sumarMontos } from './dinero';
import { diferenciaDias, esFechaContableValida, finDeMes, inicioDeMes, mesDe, sumarDias } from './fechas';
import { calcularSaldosPorCuenta, type CategoriaPersonalizada, type CuentaMetodo, type MovimientoFinanciero } from './libro';
import { historialInsuficiente, type ResultadoAnalitico } from './origen';
import type { ReglaRecurrencia } from './recurrencia_calendario';

export interface FiltroGlobalAnalitica {
  modoPeriodo: 'MES' | 'ANIO' | 'RANGO' | 'TODO';
  mes?: string; // "YYYY-MM"
  anio?: string; // "YYYY"
  desde?: string; // "YYYY-MM-DD"
  hasta?: string; // "YYYY-MM-DD"
  categoriaId?: string;
  cuentaId?: string;
  tipoOperacion?: 'TODOS' | 'INGRESO' | 'GASTO';
  eventoId?: string;
  etiqueta?: string;
}

/** Filtra los movimientos reales activos según el filtro global de analítica. */
export function filtrarMovimientosAnalitica(
  movimientos: readonly MovimientoFinanciero[],
  filtro: FiltroGlobalAnalitica,
): MovimientoFinanciero[] {
  return movimientos.filter((m) => {
    if (m.estado !== 'ACTIVO') return false;
    if (m.tipo !== 'INGRESO' && m.tipo !== 'GASTO') return false;

    if (filtro.modoPeriodo === 'MES' && filtro.mes) {
      if (mesDe(m.fechaMovimiento) !== filtro.mes) return false;
    } else if (filtro.modoPeriodo === 'ANIO' && filtro.anio) {
      if (!m.fechaMovimiento.startsWith(`${filtro.anio}-`)) return false;
    } else if (filtro.modoPeriodo === 'RANGO') {
      if (filtro.desde && m.fechaMovimiento < filtro.desde) return false;
      if (filtro.hasta && m.fechaMovimiento > filtro.hasta) return false;
    }

    if (filtro.tipoOperacion && filtro.tipoOperacion !== 'TODOS') {
      if (m.tipo !== filtro.tipoOperacion) return false;
    }
    if (filtro.cuentaId && m.cuentaId !== filtro.cuentaId) return false;
    if (filtro.categoriaId && m.categoriaId !== filtro.categoriaId && m.subcategoriaId !== filtro.categoriaId) {
      return false;
    }
    if (filtro.eventoId) {
      if (filtro.eventoId === '__SIN_EVENTO__') {
        if (m.eventoId !== null) return false;
      } else if (m.eventoId !== filtro.eventoId) {
        return false;
      }
    }
    if (filtro.etiqueta) {
      const buscada = filtro.etiqueta.trim().toLowerCase();
      if (!m.etiquetas.some((t) => t.toLowerCase() === buscada)) return false;
    }
    return true;
  });
}

// ───────────────────────── 1. WATERFALL CHART ─────────────────────────

export type SegmentoWaterfall =
  | 'INGRESOS'
  | 'GASTOS_FIJOS'
  | 'GASTOS_VARIABLES'
  | 'GASTOS_EVENTOS'
  | 'FLUJO_NETO';

export interface PasoWaterfall {
  segmento: SegmentoWaterfall;
  etiqueta: string;
  /** Monto con signo en céntimos (+ para ingresos, - para gastos, neto para flujo neto). */
  montoConSignoCentimos: MontoMinor;
  /** Valor absoluto en céntimos para visualización de barras. */
  montoAbsolutoCentimos: MontoMinor;
  /** Punto de inicio de la barra en el eje vertical (en céntimos). */
  acumuladoDesdeCentimos: MontoMinor;
  /** Punto final de la barra en el eje vertical (en céntimos). */
  acumuladoHastaCentimos: MontoMinor;
  /** IDs de las transacciones reales que componen este bloque (para drill-down). */
  movimientosIds: string[];
}

export interface ResultadoWaterfallFlujo {
  origen: 'DERIVADO';
  ingresosCentimos: MontoMinor;
  gastosFijosCentimos: MontoMinor;
  gastosVariablesCentimos: MontoMinor;
  gastosEventosCentimos: MontoMinor;
  totalGastosCentimos: MontoMinor;
  flujoNetoCentimos: MontoMinor;
  pasos: PasoWaterfall[];
  /** Comprobación matemática: Ingresos - Fijos - Variables - Eventos === Flujo Neto. */
  cuadreExacto: boolean;
}

const ETIQUETAS_FIJAS = new Set(['#fijo', '#recurrente', '#mensual', '#alquiler', '#servicios']);
const NOMBRES_CATEGORIAS_FIJAS = new Set([
  'vivienda y servicios',
  'alquiler',
  'servicios básicos',
  'educación',
  'seguros',
]);

/**
 * Clasifica un gasto real en UNA Y SOLO UNA de las tres categorías mutuamente excluyentes:
 *  1. 'GASTOS_EVENTOS'   : si tiene `eventoId !== null` (prioridad máxima: un gasto de un viaje
 *                          jamás se vuelve a sumar como gasto variable ni como fijo).
 *  2. 'GASTOS_FIJOS'     : si NO tiene `eventoId` y proviene de una regla recurrente materializada,
 *                          lleva etiqueta #Fijo/#Recurrente o pertenece a una categoría fija.
 *  3. 'GASTOS_VARIABLES' : todo otro gasto real sin `eventoId`.
 */
export function clasificarGastoMutuamenteExcluyente(
  mov: MovimientoFinanciero,
  idsMovimientosRecurrentes: ReadonlySet<string>,
  mapaCategorias: ReadonlyMap<string, CategoriaPersonalizada>,
): 'GASTOS_FIJOS' | 'GASTOS_VARIABLES' | 'GASTOS_EVENTOS' {
  if (mov.eventoId !== null) {
    return 'GASTOS_EVENTOS';
  }
  if (idsMovimientosRecurrentes.has(mov.id)) {
    return 'GASTOS_FIJOS';
  }
  if (mov.etiquetas.some((t) => ETIQUETAS_FIJAS.has(t.toLowerCase()))) {
    return 'GASTOS_FIJOS';
  }
  const cat = mov.categoriaId ? mapaCategorias.get(mov.categoriaId) : undefined;
  if (cat && NOMBRES_CATEGORIAS_FIJAS.has(cat.nombre.trim().toLowerCase())) {
    return 'GASTOS_FIJOS';
  }
  return 'GASTOS_VARIABLES';
}

export function calcularWaterfallFlujo(params: {
  movimientos: readonly MovimientoFinanciero[];
  categorias: readonly CategoriaPersonalizada[];
  reglasRecurrencia?: readonly ReglaRecurrencia[];
}): ResultadoAnalitico<ResultadoWaterfallFlujo> {
  const movs = params.movimientos.filter(
    (m) => m.estado === 'ACTIVO' && (m.tipo === 'INGRESO' || m.tipo === 'GASTO'),
  );
  if (movs.length === 0) {
    return historialInsuficiente(
      1,
      0,
      'movimiento de ingreso o gasto en el filtro seleccionado',
      'construir el gráfico Waterfall de flujo financiero',
    );
  }

  const idsRecurrentes = new Set<string>();
  for (const r of params.reglasRecurrencia ?? []) {
    for (const movId of Object.values(r.fechasMaterializadas)) {
      idsRecurrentes.add(movId);
    }
  }
  const mapaCategorias = new Map(params.categorias.map((c) => [c.id, c]));

  const idsIngresos: string[] = [];
  const montosIngresos: MontoMinor[] = [];

  const idsFijos: string[] = [];
  const montosFijos: MontoMinor[] = [];

  const idsVariables: string[] = [];
  const montosVariables: MontoMinor[] = [];

  const idsEventos: string[] = [];
  const montosEventos: MontoMinor[] = [];

  for (const m of movs) {
    if (m.tipo === 'INGRESO') {
      idsIngresos.push(m.id);
      montosIngresos.push(m.montoCentimos);
    } else if (m.tipo === 'GASTO') {
      const clase = clasificarGastoMutuamenteExcluyente(m, idsRecurrentes, mapaCategorias);
      if (clase === 'GASTOS_EVENTOS') {
        idsEventos.push(m.id);
        montosEventos.push(m.montoCentimos);
      } else if (clase === 'GASTOS_FIJOS') {
        idsFijos.push(m.id);
        montosFijos.push(m.montoCentimos);
      } else {
        idsVariables.push(m.id);
        montosVariables.push(m.montoCentimos);
      }
    }
  }

  const ingresos = sumarMontos(montosIngresos);
  const fijos = sumarMontos(montosFijos);
  const variables = sumarMontos(montosVariables);
  const eventos = sumarMontos(montosEventos);
  const totalGastos = sumarMontos([fijos, variables, eventos]);
  const flujoNeto = sumarMontos([ingresos, -fijos, -variables, -eventos]);

  const trasFijos = sumarMontos([ingresos, -fijos]);
  const trasVariables = sumarMontos([trasFijos, -variables]);
  const trasEventos = sumarMontos([trasVariables, -eventos]);

  const pasos: PasoWaterfall[] = [
    {
      segmento: 'INGRESOS',
      etiqueta: 'Ingresos',
      montoConSignoCentimos: ingresos,
      montoAbsolutoCentimos: ingresos,
      acumuladoDesdeCentimos: 0,
      acumuladoHastaCentimos: ingresos,
      movimientosIds: idsIngresos,
    },
    {
      segmento: 'GASTOS_FIJOS',
      etiqueta: 'Gastos fijos',
      montoConSignoCentimos: -fijos,
      montoAbsolutoCentimos: fijos,
      acumuladoDesdeCentimos: ingresos,
      acumuladoHastaCentimos: trasFijos,
      movimientosIds: idsFijos,
    },
    {
      segmento: 'GASTOS_VARIABLES',
      etiqueta: 'Gastos variables',
      montoConSignoCentimos: -variables,
      montoAbsolutoCentimos: variables,
      acumuladoDesdeCentimos: trasFijos,
      acumuladoHastaCentimos: trasVariables,
      movimientosIds: idsVariables,
    },
    {
      segmento: 'GASTOS_EVENTOS',
      etiqueta: 'Gastos en eventos',
      montoConSignoCentimos: -eventos,
      montoAbsolutoCentimos: eventos,
      acumuladoDesdeCentimos: trasVariables,
      acumuladoHastaCentimos: trasEventos,
      movimientosIds: idsEventos,
    },
    {
      segmento: 'FLUJO_NETO',
      etiqueta: 'Flujo neto',
      montoConSignoCentimos: flujoNeto,
      montoAbsolutoCentimos: Math.abs(flujoNeto),
      acumuladoDesdeCentimos: 0,
      acumuladoHastaCentimos: flujoNeto,
      movimientosIds: [...idsIngresos, ...idsFijos, ...idsVariables, ...idsEventos],
    },
  ];

  const fechas = movs.map((m) => m.fechaMovimiento).sort();
  return {
    estado: 'OK',
    origen: 'DERIVADO',
    datos: {
      origen: 'DERIVADO',
      ingresosCentimos: ingresos,
      gastosFijosCentimos: fijos,
      gastosVariablesCentimos: variables,
      gastosEventosCentimos: eventos,
      totalGastosCentimos: totalGastos,
      flujoNetoCentimos: flujoNeto,
      pasos,
      cuadreExacto:
        trasEventos === flujoNeto &&
        fijos + variables + eventos === totalGastos,
    },
    ventana: {
      desde: fechas[0]!,
      hasta: fechas[fechas.length - 1]!,
      observaciones: movs.length,
    },
  };
}

// ───────────────────────── 2. HEATMAP TEMPORAL (24x7) ─────────────────────────

export const DIAS_SEMANA_LIMA = [
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
  'Domingo',
] as const;

export type MetricaHeatmap = 'FRECUENCIA' | 'IMPORTE_TOTAL' | 'IMPORTE_PROMEDIO';

export interface CeldaHeatmapTemporal {
  /** 0 = Lunes ... 6 = Domingo. */
  diaSemanaIndice: number;
  diaSemanaNombre: (typeof DIAS_SEMANA_LIMA)[number];
  /** 0 .. 23 en America/Lima. */
  hora: number;
  frecuencia: number;
  importeTotalCentimos: MontoMinor;
  importePromedioCentimos: MontoMinor;
  movimientosIds: string[];
}

export interface ResultadoHeatmapTemporal {
  origen: 'DERIVADO';
  zonaHoraria: 'America/Lima';
  totalOperacionesGasto: number;
  importeTotalGastoCentimos: MontoMinor;
  celdas: CeldaHeatmapTemporal[];
}

/** Devuelve el índice 0=Lunes .. 6=Domingo para una fecha contable YYYY-MM-DD. */
export function indiceDiaSemanaLunesADomingo(fechaContable: string): number {
  const [y, m, d] = fechaContable.split('-').map(Number) as [number, number, number];
  const diaUtc = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Dom, 1=Lun, ..., 6=Sáb
  return (diaUtc + 6) % 7;
}

/** Extrae la hora (0..23) del campo horaMovimiento ("HH:mm") en America/Lima. */
export function extraerHoraLima(horaMovimiento: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(horaMovimiento.trim());
  if (!m) return null;
  return Number(m[1]);
}

export function calcularHeatmapTemporal(
  movimientos: readonly MovimientoFinanciero[],
): ResultadoAnalitico<ResultadoHeatmapTemporal> {
  const gastos = movimientos.filter((m) => m.estado === 'ACTIVO' && m.tipo === 'GASTO');
  if (gastos.length === 0) {
    return historialInsuficiente(
      1,
      0,
      'gasto registrado en el periodo',
      'construir el mapa de calor (Heatmap) temporal',
    );
  }

  // Matriz 7 días x 24 horas inicializada en 0 (sin inventar operaciones)
  const acumuladores: { montos: MontoMinor[]; ids: string[] }[][] = Array.from(
    { length: 7 },
    () => Array.from({ length: 24 }, () => ({ montos: [], ids: [] })),
  );

  for (const g of gastos) {
    if (!esFechaContableValida(g.fechaMovimiento)) continue;
    const hora = extraerHoraLima(g.horaMovimiento);
    if (hora === null) continue; // No inventa horarios si algún dato careciera de hora válida
    const diaIdx = indiceDiaSemanaLunesADomingo(g.fechaMovimiento);
    const celda = acumuladores[diaIdx]![hora]!;
    celda.montos.push(g.montoCentimos);
    celda.ids.push(g.id);
  }

  const celdas: CeldaHeatmapTemporal[] = [];
  const todosLosMontos: MontoMinor[] = [];
  let totalOperaciones = 0;

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const info = acumuladores[d]![h]!;
      const freq = info.ids.length;
      const suma = sumarMontos(info.montos);
      const prom = freq > 0 ? Number(dividirMitadPar(BigInt(suma), BigInt(freq))) : 0;
      totalOperaciones += freq;
      todosLosMontos.push(suma);
      celdas.push({
        diaSemanaIndice: d,
        diaSemanaNombre: DIAS_SEMANA_LIMA[d]!,
        hora: h,
        frecuencia: freq,
        importeTotalCentimos: suma,
        importePromedioCentimos: prom,
        movimientosIds: info.ids,
      });
    }
  }

  const fechas = gastos.map((g) => g.fechaMovimiento).sort();
  return {
    estado: 'OK',
    origen: 'DERIVADO',
    datos: {
      origen: 'DERIVADO',
      zonaHoraria: 'America/Lima',
      totalOperacionesGasto: totalOperaciones,
      importeTotalGastoCentimos: sumarMontos(todosLosMontos),
      celdas,
    },
    ventana: {
      desde: fechas[0]!,
      hasta: fechas[fechas.length - 1]!,
      observaciones: totalOperaciones,
    },
  };
}

// ───────────────────────── 3. CURVA DE LIQUIDEZ Y DESVIACIÓN (±1σ, ±2σ) ─────────────────────────

/** Mínimo de días de cobertura para calcular media y desviación estándar sin forzar modelos con datos insuficientes. */
export const MINIMO_DIAS_COBERTURA_BANDAS = 7;
export const MINIMO_DIAS_CON_GASTO_BANDAS = 3;

export interface PuntoDiarioLiquidez {
  /** Índice de día dentro de la ventana de cobertura (t = 1, 2, ..., N). */
  t: number;
  fecha: string; // YYYY-MM-DD
  ingresoDiarioCentimos: MontoMinor;
  gastoDiarioCentimos: MontoMinor;
  flujoDiarioCentimos: MontoMinor;
  /** Flujo neto acumulado real desde el inicio de la ventana (Ingresos - Gastos). */
  flujoAcumuladoRealCentimos: MontoMinor;
  /**
   * Saldo bancario real al cierre del día. Es `null` si no se dispone del saldo
   * inicial real y de todos los movimientos correspondientes.
   */
  saldoBancarioRealCierreCentimos: MontoMinor | null;
  /** Gasto acumulado real S(t) desde t = 1 hasta t. */
  gastoAcumuladoRealCentimos: MontoMinor;
  /** E[S(t)] = t * μ (en céntimos), presente solo si hay historial suficiente para bandas. */
  gastoAcumuladoEsperadoCentimos: MontoMinor | null;
  /** Bandas descriptivas E[S(t)] ± 1 * σ * sqrt(t) y E[S(t)] ± 2 * σ * sqrt(t). */
  bandaMas1SigmaCentimos: MontoMinor | null;
  bandaMenos1SigmaCentimos: MontoMinor | null;
  bandaMas2SigmaCentimos: MontoMinor | null;
  bandaMenos2SigmaCentimos: MontoMinor | null;
}

export interface EstadisticosBandasGasto {
  diasCobertura: number;
  diasConGasto: number;
  /** Media diaria de gasto μ en céntimos. */
  mediaDiariaCentimos: number;
  /** Desviación estándar diaria muestral σ en céntimos. */
  desviacionEstandarDiariaCentimos: number;
  notaMetodologica: string;
}

export interface ResultadoCurvaLiquidezYDesviacion {
  origen: 'DERIVADO';
  desde: string;
  hasta: string;
  tieneSaldoBancarioRealCompleto: boolean;
  advertenciaSaldoBancario: string | null;
  puntosDiarios: PuntoDiarioLiquidez[];
  bandasEstadisticas: ResultadoAnalitico<EstadisticosBandasGasto>;
}

/**
 * Calcula la curva de liquidez diaria y las bandas de variabilidad del gasto acumulado:
 *  - E[S(t)] = t * μ
 *  - σ_acum(t) = σ * sqrt(t)
 *  - Bandas: E[S(t)] ± 1σ_acum(t) y E[S(t)] ± 2σ_acum(t)
 */
export function calcularCurvaLiquidezYDesviacion(params: {
  movimientos: readonly MovimientoFinanciero[];
  cuentas: readonly CuentaMetodo[];
  desdeForzado?: string;
  hastaForzado?: string;
  /** Historial completo (incluyendo SALDO_INICIAL y TRANSFERENCIA) para conciliar el saldo bancario real. */
  movimientosCompletos?: readonly MovimientoFinanciero[];
  /** Si se filtró por una cuenta específica, concilia el saldo bancario contra esa cuenta. */
  cuentaFiltradaId?: string;
  /** Si hay filtro por categoría, evento o etiqueta, el flujo es parcial y no representa un saldo bancario de cuenta. */
  tieneFiltroParcialNoBancario?: boolean;
}): ResultadoAnalitico<ResultadoCurvaLiquidezYDesviacion> {
  const activos = params.movimientos.filter(
    (m) => m.estado === 'ACTIVO' && (m.tipo === 'INGRESO' || m.tipo === 'GASTO'),
  );
  if (activos.length === 0) {
    return historialInsuficiente(
      1,
      0,
      'movimiento registrado',
      'construir la curva de liquidez y desviación diaria',
    );
  }

  const fechasOrdenadas = activos.map((m) => m.fechaMovimiento).sort();
  const desde = params.desdeForzado && esFechaContableValida(params.desdeForzado)
    ? params.desdeForzado
    : fechasOrdenadas[0]!;
  const hasta = params.hastaForzado && esFechaContableValida(params.hastaForzado) && params.hastaForzado >= desde
    ? params.hastaForzado
    : fechasOrdenadas[fechasOrdenadas.length - 1]!;

  const totalDias = diferenciaDias(desde, hasta) + 1;
  if (totalDias <= 0 || totalDias > 3660) {
    return historialInsuficiente(
      1,
      0,
      'ventana de fechas válida (máximo 10 años por consulta diaria)',
      'calcular la curva diaria de liquidez',
    );
  }

  // Verificar si las cuentas involucradas tienen saldo inicial real completo
  const movsBaseSaldo = (params.movimientosCompletos ?? params.movimientos).filter(
    (m) => m.estado === 'ACTIVO',
  );
  const saldosCuentas = calcularSaldosPorCuenta(params.cuentas, movsBaseSaldo);
  const cuentasUsadasIds = params.cuentaFiltradaId
    ? new Set([params.cuentaFiltradaId])
    : new Set(activos.map((m) => m.cuentaId));
  const saldosDeCuentasUsadas = saldosCuentas.filter((s) => cuentasUsadasIds.has(s.cuentaId));
  const tieneSaldoBancarioRealCompleto =
    !params.tieneFiltroParcialNoBancario &&
    saldosDeCuentasUsadas.length > 0 &&
    saldosDeCuentasUsadas.every((s) => s.estadoSaldo === 'SALDO_REAL_COMPLETO');

  // Calcular saldo bancario base previo al inicio de la ventana `desde` (SALDO_INICIAL + flujos previos a `desde`)
  const transferenciasNetasPorDia = new Map<string, MontoMinor[]>();
  let saldoInicialTotalPrevio: MontoMinor | null = null;
  if (tieneSaldoBancarioRealCompleto) {
    const componentesPrevios: MontoMinor[] = saldosDeCuentasUsadas.map(
      (s) => s.saldoInicialCentimos ?? 0,
    );
    for (const m of movsBaseSaldo) {
      if (m.tipo === 'SALDO_INICIAL') continue;
      const afectaOrigen = cuentasUsadasIds.has(m.cuentaId);
      const afectaDestino =
        m.tipo === 'TRANSFERENCIA' &&
        m.cuentaDestinoId !== null &&
        cuentasUsadasIds.has(m.cuentaDestinoId);
      if (!afectaOrigen && !afectaDestino) continue;

      if (m.fechaMovimiento < desde) {
        if (m.tipo === 'INGRESO' && afectaOrigen) componentesPrevios.push(m.montoCentimos);
        else if (m.tipo === 'GASTO' && afectaOrigen) componentesPrevios.push(-m.montoCentimos);
        else if (m.tipo === 'TRANSFERENCIA') {
          if (afectaOrigen) componentesPrevios.push(-m.montoCentimos);
          if (afectaDestino) componentesPrevios.push(m.montoCentimos);
        }
      } else if (m.fechaMovimiento <= hasta && m.tipo === 'TRANSFERENCIA') {
        const arr = transferenciasNetasPorDia.get(m.fechaMovimiento) ?? [];
        if (afectaOrigen) arr.push(-m.montoCentimos);
        if (afectaDestino) arr.push(m.montoCentimos);
        transferenciasNetasPorDia.set(m.fechaMovimiento, arr);
      }
    }
    saldoInicialTotalPrevio = sumarMontos(componentesPrevios);
  }

  // Agrupar ingresos y gastos por fecha YYYY-MM-DD
  const ingresosPorDia = new Map<string, MontoMinor[]>();
  const gastosPorDia = new Map<string, MontoMinor[]>();
  for (const m of activos) {
    if (m.fechaMovimiento < desde || m.fechaMovimiento > hasta) continue;
    if (m.tipo === 'INGRESO') {
      const arr = ingresosPorDia.get(m.fechaMovimiento) ?? [];
      arr.push(m.montoCentimos);
      ingresosPorDia.set(m.fechaMovimiento, arr);
    } else if (m.tipo === 'GASTO') {
      const arr = gastosPorDia.get(m.fechaMovimiento) ?? [];
      arr.push(m.montoCentimos);
      gastosPorDia.set(m.fechaMovimiento, arr);
    }
  }

  const vectorGastosDiarios: MontoMinor[] = [];
  const fechasDias: string[] = [];
  for (let i = 0; i < totalDias; i++) {
    const f = sumarDias(desde, i);
    fechasDias.push(f);
    vectorGastosDiarios.push(sumarMontos(gastosPorDia.get(f) ?? []));
  }

  const diasConGasto = vectorGastosDiarios.filter((g) => g > 0).length;
  let bandasEstadisticas: ResultadoAnalitico<EstadisticosBandasGasto>;
  let mu = 0;
  let sigma = 0;
  const hayBandas =
    totalDias >= MINIMO_DIAS_COBERTURA_BANDAS && diasConGasto >= MINIMO_DIAS_CON_GASTO_BANDAS;

  if (!hayBandas) {
    bandasEstadisticas = historialInsuficiente(
      MINIMO_DIAS_COBERTURA_BANDAS,
      totalDias,
      `días de cobertura (con al menos ${MINIMO_DIAS_CON_GASTO_BANDAS} días con gasto; hay ${diasConGasto})`,
      'calcular las bandas estadísticas ±1σ y ±2σ de gasto acumulado',
    );
  } else {
    const sumaGastos = sumarMontos(vectorGastosDiarios);
    mu = sumaGastos / totalDias;
    const sumaCuadrados = vectorGastosDiarios.reduce((acc, g) => {
      const diff = g - mu;
      return acc + diff * diff;
    }, 0);
    sigma = Math.sqrt(sumaCuadrados / (totalDias - 1));

    bandasEstadisticas = {
      estado: 'OK',
      origen: 'DERIVADO',
      datos: {
        diasCobertura: totalDias,
        diasConGasto,
        mediaDiariaCentimos: Math.round(mu),
        desviacionEstandarDiariaCentimos: Math.round(sigma),
        notaMetodologica:
          'Bandas descriptivas calculadas con E[S(t)] = t × μ y σ_acum(t) = σ × √t bajo el supuesto de independencia diaria; no son intervalos de confianza garantizados.',
      },
      ventana: {
        desde,
        hasta,
        observaciones: totalDias,
      },
    };
  }

  const puntosDiarios: PuntoDiarioLiquidez[] = [];
  let flujoAcumulado = 0;
  let transferenciasNetasAcumuladas = 0;
  let gastoAcumulado = 0;

  for (let i = 0; i < totalDias; i++) {
    const t = i + 1;
    const fecha = fechasDias[i]!;
    const ingDia = sumarMontos(ingresosPorDia.get(fecha) ?? []);
    const gasDia = vectorGastosDiarios[i]!;
    const transfNetaDia = sumarMontos(transferenciasNetasPorDia.get(fecha) ?? []);
    const flujoDia = sumarMontos([ingDia, -gasDia]);
    flujoAcumulado = sumarMontos([flujoAcumulado, flujoDia]);
    transferenciasNetasAcumuladas = sumarMontos([transferenciasNetasAcumuladas, transfNetaDia]);
    gastoAcumulado = sumarMontos([gastoAcumulado, gasDia]);

    let esperado: MontoMinor | null = null;
    let mas1: MontoMinor | null = null;
    let menos1: MontoMinor | null = null;
    let mas2: MontoMinor | null = null;
    let menos2: MontoMinor | null = null;

    if (hayBandas) {
      const eSt = t * mu;
      const sigmaAcum = sigma * Math.sqrt(t);
      esperado = Math.round(eSt);
      mas1 = Math.round(eSt + sigmaAcum);
      menos1 = Math.max(0, Math.round(eSt - sigmaAcum));
      mas2 = Math.round(eSt + 2 * sigmaAcum);
      menos2 = Math.max(0, Math.round(eSt - 2 * sigmaAcum));
    }

    puntosDiarios.push({
      t,
      fecha,
      ingresoDiarioCentimos: ingDia,
      gastoDiarioCentimos: gasDia,
      flujoDiarioCentimos: flujoDia,
      flujoAcumuladoRealCentimos: flujoAcumulado,
      saldoBancarioRealCierreCentimos:
        saldoInicialTotalPrevio !== null
          ? sumarMontos([
              saldoInicialTotalPrevio,
              flujoAcumulado,
              transferenciasNetasAcumuladas,
            ])
          : null,
      gastoAcumuladoRealCentimos: gastoAcumulado,
      gastoAcumuladoEsperadoCentimos: esperado,
      bandaMas1SigmaCentimos: mas1,
      bandaMenos1SigmaCentimos: menos1,
      bandaMas2SigmaCentimos: mas2,
      bandaMenos2SigmaCentimos: menos2,
    });
  }

  return {
    estado: 'OK',
    origen: 'DERIVADO',
    datos: {
      origen: 'DERIVADO',
      desde,
      hasta,
      tieneSaldoBancarioRealCompleto,
      advertenciaSaldoBancario: tieneSaldoBancarioRealCompleto
        ? null
        : 'Se muestra el flujo acumulado real de movimientos. El saldo bancario real no se grafica porque una o más cuentas carecen de saldo inicial verificado.',
      puntosDiarios,
      bandasEstadisticas,
    },
    ventana: {
      desde,
      hasta,
      observaciones: activos.length,
    },
  };
}

// ───────────────────────── 4. PARETO 80/20 DE CATEGORÍAS ─────────────────────────

export interface FilaParetoCategoria {
  categoriaId: string;
  nombreCategoria: string;
  importeCentimos: MontoMinor;
  /** Porcentaje individual sobre el total en basis points (10000 = 100.00%). */
  porcentajeSobreTotalBp: number;
  /** Porcentaje acumulado en basis points (10000 = 100.00%). */
  porcentajeAcumuladoBp: number;
  /** true si esta categoría forma parte del núcleo vital que concentra hasta el ~80% del gasto. */
  concentraNucleo80: boolean;
  movimientosIds: string[];
}

export interface ResultadoParetoCategorias {
  origen: 'DERIVADO';
  totalGastoCentimos: MontoMinor;
  lineaReferenciaPorcentaje: 80;
  categoriasVitales80: string[];
  filas: FilaParetoCategoria[];
}

export function calcularParetoCategorias(params: {
  movimientos: readonly MovimientoFinanciero[];
  categorias: readonly CategoriaPersonalizada[];
}): ResultadoAnalitico<ResultadoParetoCategorias> {
  const gastos = params.movimientos.filter((m) => m.estado === 'ACTIVO' && m.tipo === 'GASTO');
  const totalGasto = sumarMontos(gastos.map((g) => g.montoCentimos));

  if (gastos.length === 0 || totalGasto === 0) {
    return historialInsuficiente(
      1,
      0,
      'gasto registrado en el filtro actual',
      'calcular el análisis de Pareto 80/20 por categorías',
    );
  }

  const mapaNombres = new Map(params.categorias.map((c) => [c.id, c.nombre]));
  const agrupado = new Map<string, { montos: MontoMinor[]; ids: string[] }>();

  for (const g of gastos) {
    const cid = g.categoriaId ?? 'sin_categoria';
    const actual = agrupado.get(cid) ?? { montos: [], ids: [] };
    actual.montos.push(g.montoCentimos);
    actual.ids.push(g.id);
    agrupado.set(cid, actual);
  }

  const ordenadas = [...agrupado.entries()]
    .map(([categoriaId, info]) => ({
      categoriaId,
      nombreCategoria: mapaNombres.get(categoriaId) ?? 'Sin categoría',
      importeCentimos: sumarMontos(info.montos),
      movimientosIds: info.ids,
    }))
    .sort((a, b) => b.importeCentimos - a.importeCentimos);

  let acumuladoCentimos = 0;
  let yaCruzo80 = false;
  const categoriasVitales80: string[] = [];

  const filas: FilaParetoCategoria[] = ordenadas.map((item) => {
    acumuladoCentimos = sumarMontos([acumuladoCentimos, item.importeCentimos]);
    const pctIndividualBp = Number(
      dividirMitadPar(BigInt(item.importeCentimos) * 10000n, BigInt(totalGasto)),
    );
    const pctAcumBp = Number(
      dividirMitadPar(BigInt(acumuladoCentimos) * 10000n, BigInt(totalGasto)),
    );
    const esVital = !yaCruzo80;
    if (esVital) {
      categoriasVitales80.push(item.nombreCategoria);
    }
    if (pctAcumBp >= 8000) {
      yaCruzo80 = true;
    }
    return {
      categoriaId: item.categoriaId,
      nombreCategoria: item.nombreCategoria,
      importeCentimos: item.importeCentimos,
      porcentajeSobreTotalBp: pctIndividualBp,
      porcentajeAcumuladoBp: pctAcumBp,
      concentraNucleo80: esVital,
      movimientosIds: item.movimientosIds,
    };
  });

  const fechas = gastos.map((g) => g.fechaMovimiento).sort();
  return {
    estado: 'OK',
    origen: 'DERIVADO',
    datos: {
      origen: 'DERIVADO',
      totalGastoCentimos: totalGasto,
      lineaReferenciaPorcentaje: 80,
      categoriasVitales80,
      filas,
    },
    ventana: {
      desde: fechas[0]!,
      hasta: fechas[fechas.length - 1]!,
      observaciones: gastos.length,
    },
  };
}

/** Calcula los límites de fechas `[desde, hasta]` para un `FiltroGlobalAnalitica`. */
export function resolverVentanaFechasFiltro(filtro: FiltroGlobalAnalitica): {
  desde?: string;
  hasta?: string;
} {
  if (filtro.modoPeriodo === 'MES' && filtro.mes) {
    const base = `${filtro.mes}-01`;
    if (esFechaContableValida(base)) {
      return { desde: inicioDeMes(base), hasta: finDeMes(base) };
    }
  }
  if (filtro.modoPeriodo === 'ANIO' && filtro.anio && /^\d{4}$/.test(filtro.anio)) {
    return { desde: `${filtro.anio}-01-01`, hasta: `${filtro.anio}-12-31` };
  }
  if (filtro.modoPeriodo === 'RANGO') {
    return { desde: filtro.desde, hasta: filtro.hasta };
  }
  return {};
}
