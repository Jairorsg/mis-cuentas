/**
 * Fase 4 — Simulación de Monte Carlo (1,000 iteraciones) mediante Remuestreo No Paramétrico.
 *
 * REGLAS INNEGOCIABLES:
 *  - Utiliza EXCLUSIVAMENTE observaciones diarias históricas reales.
 *  - No asume normalidad paramétrica ni inventa medias, varianzas o distribuciones sintéticas.
 *  - Prefiere Bootstrap por Bloques Móviles (Moving Block Bootstrap) cuando existen
 *    suficientes observaciones para preservar patrones temporales / semanales, o
 *    Bootstrap Empírico IID cuando la serie es corta o sin dependencia serial.
 *  - Devuelve `HISTORIAL_INSUFICIENTE` cuando el historial no permite una estimación
 *    fiable (< 7 días observados o < 3 días con movimiento).
 */
import type { MontoMinor } from '../dinero';
import { historialInsuficiente, type ResultadoAnalitico } from '../origen';
import type { SerieTemporalDiaria } from './preparacion';

export const ITERACIONES_MONTE_CARLO_DEFAULT = 1000;

export type MetodoRemuestreoMonteCarlo = 'BOOTSTRAP_BLOQUES_MOVILES' | 'BOOTSTRAP_EMPIRICO';

export interface CubetaHistogramaMonteCarlo {
  desdeCentimos: MontoMinor;
  hastaCentimos: MontoMinor;
  frecuencia: number;
  probabilidad: number;
}

export interface ResultadoMonteCarloPresupuesto {
  origen: 'PROYECTADO';
  /** Número de observaciones diarias reales utilizadas como base empírica. */
  numeroObservaciones: number;
  /** Días con gasto efectivo (> 0) dentro de la ventana observada. */
  diasConGastoObservados: number;
  /** Periodo histórico real analizado. */
  periodoAnalizado: {
    desde: string;
    hasta: string;
  };
  /** Horizonte futuro simulado en días calendario (H). */
  horizonteDiasRestantes: number;
  /** Gasto real ya acumulado antes del horizonte futuro. */
  gastoAcumuladoActualCentimos: MontoMinor;
  /** Gasto comprometido adicional conocido (p. ej. reservas de eventos no registradas aún). */
  comprometidoAdicionalCentimos: MontoMinor;
  /** Presupuesto objetivo contra el cual se evalúa el riesgo (null si no se definió presupuesto). */
  presupuestoObjetivoCentimos: MontoMinor | null;
  /** Método de remuestreo empleado. */
  metodoUtilizado: MetodoRemuestreoMonteCarlo;
  /** Longitud del bloque temporal L (1 para Bootstrap empírico IID, >1 para Bloques Móviles). */
  longitudBloqueDias: number;
  /** Número de iteraciones de Monte Carlo ejecutadas (1,000 por defecto). */
  numeroSimulaciones: number;
  /** Probabilidad estimada de superar el presupuesto (0..1), o null si no hay presupuesto definido. */
  probabilidadSuperarPresupuesto: number | null;
  /** Número de trayectorias simuladas que excedieron el presupuesto. */
  simulacionesQueExcedenPresupuesto: number | null;
  /** Escenario Favorable (Percentil 10 - P10: solo 10% de escenarios gastan menos que esto). */
  escenarioFavorableP10Centimos: MontoMinor;
  /** Escenario Central (Percentil 50 / Mediana empírica). */
  escenarioCentralMedianaCentimos: MontoMinor;
  /** Promedio aritmético de las 1,000 simulaciones. */
  mediaSimuladaCentimos: MontoMinor;
  /** Escenario Desfavorable (Percentil 90 - P90: gasto alto en escenario adverso). */
  escenarioDesfavorableP90Centimos: MontoMinor;
  /** Percentil 2.5 y Percentil 97.5 (Intervalo empírico del 95 % de Monte Carlo). */
  percentil2_5Centimos: MontoMinor;
  percentil97_5Centimos: MontoMinor;
  /** Distribución resumida en 10 cubetas para visualización de densidad empírica. */
  histogramaDistribución: CubetaHistogramaMonteCarlo[];
  /** Supuestos explícitos del modelo de remuestreo. */
  supuestos: string[];
  /** Limitaciones metodológicas explícitas. */
  limitaciones: string[];
}

/**
 * Generador pseudoaleatorio determinista de 32 bits (Mulberry32).
 * Se inicializa con una semilla derivada de los propios datos reales observados
 * para garantizar reproducibilidad exacta y auditabilidad sin usar datos ficticios.
 */
function crearGeneradorDeterminista(semilla: number): () => number {
  let estado = semilla >>> 0;
  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calcularSemillaDesdeDatos(
  valores: readonly number[],
  horizonte: number,
  presupuesto: number | null,
): number {
  let hash = 2166136261 ^ horizonte ^ (presupuesto ?? 0);
  for (let i = 0; i < valores.length; i++) {
    hash ^= valores[i]! + (i + 1) * 31;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function percentilOrdenado(ordenados: readonly number[], p: number): MontoMinor {
  if (ordenados.length === 0) return 0;
  const pos = (ordenados.length - 1) * p;
  const base = Math.floor(pos);
  const resto = pos - base;
  const inf = ordenados[base]!;
  const sup = ordenados[Math.min(ordenados.length - 1, base + 1)]!;
  return Math.round(inf + resto * (sup - inf));
}

/**
 * Ejecuta la simulación de Monte Carlo (1,000 iteraciones por defecto) sobre
 * una serie temporal diaria de gastos reales observados.
 */
export function ejecutarSimulacionMonteCarlo(params: {
  serieGastos: SerieTemporalDiaria | null;
  gastoAcumuladoActualCentimos: MontoMinor;
  comprometidoAdicionalCentimos?: MontoMinor;
  horizonteDiasRestantes: number;
  presupuestoObjetivoCentimos: MontoMinor | null;
  iteraciones?: number;
  contextoNombre?: string;
}): ResultadoAnalitico<ResultadoMonteCarloPresupuesto> {
  const {
    serieGastos,
    gastoAcumuladoActualCentimos,
    comprometidoAdicionalCentimos = 0,
    horizonteDiasRestantes,
    presupuestoObjetivoCentimos,
    iteraciones = ITERACIONES_MONTE_CARLO_DEFAULT,
    contextoNombre = 'el periodo',
  } = params;

  if (!serieGastos) {
    return historialInsuficiente(
      7,
      0,
      'días de cobertura real observada',
      `ejecutar simulación Monte Carlo de ${contextoNombre}`,
    );
  }

  const n = serieGastos.valoresCentimos.length;
  const diasConGasto = serieGastos.diagnostico.diasConActividad;

  if (n < 7 || diasConGasto < 3) {
    return historialInsuficiente(
      7,
      n,
      `días observados con al menos 3 días de gasto real (actualmente ${diasConGasto} día(s) con gasto)`,
      `ejecutar simulación Monte Carlo de ${contextoNombre} sin fabricar probabilidades`,
    );
  }

  const valores = serieGastos.valoresCentimos;

  // Selección rigurosa entre Bootstrap por Bloques Móviles y Bootstrap Empírico IID:
  // Si hay >= 14 días y dependencia temporal relevante (|ρ_1| >= 0.20 o |ρ_7| >= 0.20 o n >= 21),
  // empleamos Bloques Móviles para conservar la agrupación intra-semana (fines de semana vs. días laborales).
  const rho1 = Math.abs(serieGastos.diagnostico.autocorrelacionLag1);
  const rho7 = Math.abs(serieGastos.diagnostico.autocorrelacionLag7 ?? 0);
  const usarBloques = n >= 14 && (n >= 21 || rho1 >= 0.2 || rho7 >= 0.2);

  const metodoUtilizado: MetodoRemuestreoMonteCarlo = usarBloques
    ? 'BOOTSTRAP_BLOQUES_MOVILES'
    : 'BOOTSTRAP_EMPIRICO';

  const longitudBloqueDias = usarBloques
    ? n >= 21
      ? 7
      : Math.max(2, Math.round(Math.cbrt(n)))
    : 1;

  const baseConocida = gastoAcumuladoActualCentimos + comprometidoAdicionalCentimos;
  const numSim = Math.max(100, iteraciones);

  // Si el horizonte restante es 0 días (periodo o evento ya concluido), la distribución colapsa en el valor real
  const totalesSimulados: number[] = [];
  if (horizonteDiasRestantes <= 0) {
    for (let m = 0; m < numSim; m++) {
      totalesSimulados.push(baseConocida);
    }
  } else {
    const rng = crearGeneradorDeterminista(
      calcularSemillaDesdeDatos(valores, horizonteDiasRestantes, presupuestoObjetivoCentimos),
    );
    const maxInicioBloque = Math.max(1, n - longitudBloqueDias + 1);

    for (let m = 0; m < numSim; m++) {
      let gastoFuturoSimulado = 0;
      let diasSimulados = 0;

      if (metodoUtilizado === 'BOOTSTRAP_BLOQUES_MOVILES') {
        while (diasSimulados < horizonteDiasRestantes) {
          const inicio = Math.floor(rng() * maxInicioBloque);
          for (
            let j = 0;
            j < longitudBloqueDias && diasSimulados < horizonteDiasRestantes;
            j++
          ) {
            gastoFuturoSimulado += valores[inicio + j]!;
            diasSimulados += 1;
          }
        }
      } else {
        while (diasSimulados < horizonteDiasRestantes) {
          const idx = Math.floor(rng() * n);
          gastoFuturoSimulado += valores[idx]!;
          diasSimulados += 1;
        }
      }

      totalesSimulados.push(baseConocida + gastoFuturoSimulado);
    }
  }

  const ordenados = [...totalesSimulados].sort((a, b) => a - b);
  const mediaSimulada = Math.round(
    totalesSimulados.reduce((acc, v) => acc + v, 0) / numSim,
  );
  const p10 = percentilOrdenado(ordenados, 0.1);
  const p50 = percentilOrdenado(ordenados, 0.5);
  const p90 = percentilOrdenado(ordenados, 0.9);
  const p2_5 = percentilOrdenado(ordenados, 0.025);
  const p97_5 = percentilOrdenado(ordenados, 0.975);

  let probabilidadSuperarPresupuesto: number | null = null;
  let simulacionesQueExcedenPresupuesto: number | null = null;

  if (presupuestoObjetivoCentimos !== null && presupuestoObjetivoCentimos > 0) {
    const excedidos = totalesSimulados.filter(
      (total) => total > presupuestoObjetivoCentimos,
    ).length;
    simulacionesQueExcedenPresupuesto = excedidos;
    probabilidadSuperarPresupuesto = Number((excedidos / numSim).toFixed(4));
  }

  // Construir histograma empírico de 10 cubetas
  const minVal = ordenados[0]!;
  const maxVal = ordenados[ordenados.length - 1]!;
  const numCubetas = 10;
  const histogramaDistribución: CubetaHistogramaMonteCarlo[] = [];

  if (maxVal === minVal) {
    histogramaDistribución.push({
      desdeCentimos: minVal,
      hastaCentimos: maxVal,
      frecuencia: numSim,
      probabilidad: 1,
    });
  } else {
    const ancho = (maxVal - minVal) / numCubetas;
    const conteos = new Array<number>(numCubetas).fill(0);
    for (const v of ordenados) {
      const idx = Math.min(numCubetas - 1, Math.floor((v - minVal) / ancho));
      conteos[idx]! += 1;
    }
    for (let c = 0; c < numCubetas; c++) {
      const d = Math.round(minVal + c * ancho);
      const h = c === numCubetas - 1 ? maxVal : Math.round(minVal + (c + 1) * ancho);
      histogramaDistribución.push({
        desdeCentimos: d,
        hastaCentimos: h,
        frecuencia: conteos[c]!,
        probabilidad: Number((conteos[c]! / numSim).toFixed(4)),
      });
    }
  }

  const supuestos: string[] = [
    'Las observaciones diarias futuras provienen de la misma distribución empírica observada en la ventana histórica real.',
    metodoUtilizado === 'BOOTSTRAP_BLOQUES_MOVILES'
      ? `El remuestreo por bloques contiguos de ${longitudBloqueDias} días preserva la correlación intra-bloque y los hábitos semanales sin asumir normalidad.`
      : 'El remuestreo empírico IID extrae con reemplazo días reales observados sin asumir distribución normal ni parámetros artificiales.',
  ];
  if (comprometidoAdicionalCentimos > 0) {
    supuestos.push(
      `Se incorpora como piso determinista el gasto comprometido aún no liquidado (S/ ${(comprometidoAdicionalCentimos / 100).toFixed(2)}).`,
    );
  }

  const limitaciones: string[] = [
    'Un escenario de Monte Carlo es una proyección probabilística basada en datos pasados, no un movimiento real ni una certeza.',
    'Gastos extraordinarios futuros que nunca hayan ocurrido en el historial observado no pueden ser anticipados únicamente por remuestreo empírico.',
  ];
  if (n < 30) {
    limitaciones.push(
      `La muestra histórica cuenta con ${n} días observados; la precisión de los percentiles extremos (P10/P90) aumentará conforme se acumulen más semanas de registro.`,
    );
  }

  return {
    estado: 'OK',
    origen: 'PROYECTADO',
    metodo:
      metodoUtilizado === 'BOOTSTRAP_BLOQUES_MOVILES'
        ? `Monte Carlo (${numSim} iteraciones) con Bootstrap por Bloques Móviles (L = ${longitudBloqueDias} días)`
        : `Monte Carlo (${numSim} iteraciones) con Bootstrap Empírico IID`,
    ventana: {
      desde: serieGastos.desde,
      hasta: serieGastos.hasta,
      observaciones: n,
    },
    datos: {
      origen: 'PROYECTADO',
      numeroObservaciones: n,
      diasConGastoObservados: diasConGasto,
      periodoAnalizado: {
        desde: serieGastos.desde,
        hasta: serieGastos.hasta,
      },
      horizonteDiasRestantes,
      gastoAcumuladoActualCentimos,
      comprometidoAdicionalCentimos,
      presupuestoObjetivoCentimos,
      metodoUtilizado,
      longitudBloqueDias,
      numeroSimulaciones: numSim,
      probabilidadSuperarPresupuesto,
      simulacionesQueExcedenPresupuesto,
      escenarioFavorableP10Centimos: p10,
      escenarioCentralMedianaCentimos: p50,
      mediaSimuladaCentimos: mediaSimulada,
      escenarioDesfavorableP90Centimos: p90,
      percentil2_5Centimos: p2_5,
      percentil97_5Centimos: p97_5,
      histogramaDistribución,
      supuestos,
      limitaciones,
    },
  };
}
