/**
 * Fase 4 — Validación Temporal Fuera de Muestra (Backtesting Walk-Forward).
 *
 * REGLA INNEGOCIABLE:
 *  - Prohibido usar particiones aleatorias (random split / k-fold aleatorio) que
 *    mezclen pasado y futuro (fuga temporal de datos).
 *  - Toda evaluación se realiza con ventana expansiva cronológica (walk-forward):
 *    en cada corte temporal k, el modelo se estima únicamente con [y_1 .. y_k]
 *    (pasado) y predice y_{k+1} (futuro inmediato no visto).
 *  - Todos los modelos candidatos admisibles se evalúan exactamente sobre la misma
 *    ventana de prueba cronológica para garantizar una comparación justa.
 */
import {
  ajustarHolt,
  ajustarHoltWintersAditivo,
  ajustarMCO,
  ajustarSES,
  type MetodoPronostico,
  type ModeloSerieAjustado,
  type ParametrosModeloEstimado,
} from './estimacion';

export interface EvaluacionBacktestingModelo {
  metodo: MetodoPronostico;
  nombreLegible: string;
  evaluado: boolean;
  motivoNoEvaluado?: string;
  /** Raíz del Error Cuadrático Medio fuera de muestra (en céntimos). */
  rmseOutSampleCentimos: number | null;
  /** Error Absoluto Medio fuera de muestra (en céntimos). */
  maeOutSampleCentimos: number | null;
  /** Error medio con signo (Sesgo = media(y_real - y_pred)) fuera de muestra (en céntimos). */
  sesgoMedioOutSampleCentimos: number | null;
  /** Error porcentual absoluto medio simétrico (sMAPE 0..200%). */
  smapeOutSamplePorcentaje: number | null;
  /** Cantidad de pasos temporales de validación evaluados fuera de muestra. */
  pasosValidados: number;
  /** Residuos fuera de muestra e_t = y_t - ŷ_{t|t-1}. */
  erroresOutSample: number[];
}

export interface ResultadoSeleccionBacktesting {
  particionCronologicaEstricta: true;
  totalObservaciones: number;
  indiceCorteInicialEntrenamiento: number;
  pasosValidacionOutSample: number;
  metodoSeleccionado: MetodoPronostico;
  justificacionSeleccion: string;
  comparativaModelos: EvaluacionBacktestingModelo[];
  modeloFinalReentrenado: ModeloSerieAjustado;
  erroresOutSampleGanador: number[];
}

const ORDEN_PARSIMONIA: Record<MetodoPronostico, number> = {
  SES: 1,
  MCO: 2,
  HOLT: 3,
  HOLT_WINTERS: 4,
};

function ajustarPorMetodo(serie: readonly number[], metodo: MetodoPronostico): ModeloSerieAjustado {
  switch (metodo) {
    case 'MCO':
      return ajustarMCO(serie);
    case 'SES':
      return ajustarSES(serie);
    case 'HOLT':
      return ajustarHolt(serie);
    case 'HOLT_WINTERS':
      return ajustarHoltWintersAditivo(serie, 7);
  }
}

/**
 * Ejecuta validación walk-forward cronológica fuera de muestra sobre `serie`,
 * compara MCO, SES, Holt y Holt-Winters (cuando N >= 21), selecciona el mejor
 * modelo según RMSE fuera de muestra y lo reentrena con la serie completa [1..N].
 */
export function seleccionarModeloPorBacktesting(
  serie: readonly number[],
  aptoHoltWintersSemanal: boolean,
): ResultadoSeleccionBacktesting {
  const n = serie.length;
  if (n < 7) {
    throw new Error(
      `Se requieren al menos 7 observaciones cronológicas para ejecutar backtesting temporal (disponibles: ${n}).`,
    );
  }

  // Determinar ventana de validación cronológica final (último ~30% de la serie, entre 3 y 14 pasos)
  // Si Holt-Winters es elegible (n >= 21), garantizamos que el primer corte de entrenamiento tenga al menos 14 días (2 ciclos semanales).
  const minEntrenamiento = aptoHoltWintersSemanal && n >= 21 ? 14 : Math.max(4, Math.floor(n * 0.65));
  const corteInicial = Math.min(n - 3, Math.max(minEntrenamiento, n - 10));
  const pasosValidacion = n - corteInicial;

  const candidatos: { metodo: MetodoPronostico; nombre: string; elegible: boolean; motivo?: string }[] = [
    {
      metodo: 'MCO',
      nombre: 'Mínimos Cuadrados Ordinarios (MCO)',
      elegible: true,
    },
    {
      metodo: 'SES',
      nombre: 'Suavizamiento Exponencial Simple (SES)',
      elegible: true,
    },
    {
      metodo: 'HOLT',
      nombre: 'Método de Holt con Tendencia',
      elegible: true,
    },
    {
      metodo: 'HOLT_WINTERS',
      nombre: 'Holt-Winters Aditivo (Estacionalidad Semanal m=7)',
      elegible: aptoHoltWintersSemanal && corteInicial >= 14,
      motivo:
        aptoHoltWintersSemanal && corteInicial >= 14
          ? undefined
          : 'Requiere al menos 21 días observados (14 días de entrenamiento + ventana de validación) y actividad suficiente para estimar estacionalidad semanal.',
    },
  ];

  const comparativaModelos: EvaluacionBacktestingModelo[] = [];

  for (const cand of candidatos) {
    if (!cand.elegible) {
      comparativaModelos.push({
        metodo: cand.metodo,
        nombreLegible: cand.nombre,
        evaluado: false,
        motivoNoEvaluado: cand.motivo,
        rmseOutSampleCentimos: null,
        maeOutSampleCentimos: null,
        sesgoMedioOutSampleCentimos: null,
        smapeOutSamplePorcentaje: null,
        pasosValidados: 0,
        erroresOutSample: [],
      });
      continue;
    }

    const errores: number[] = [];
    let sumaCuadrados = 0;
    let sumaAbs = 0;
    let sumaSesgo = 0;
    let sumaSmape = 0;

    // Walk-Forward estricto: para cada k desde corteInicial hasta n - 1,
    // entrenamos SOLO con serie[0 .. k-1] (pasado) y predecimos serie[k] (futuro).
    for (let k = corteInicial; k < n; k++) {
      const pasadoEntrenamiento = serie.slice(0, k);
      const valorFuturoReal = serie[k]!;
      const modeloPaso = ajustarPorMetodo(pasadoEntrenamiento, cand.metodo);
      const pred1Paso = modeloPaso.pronosticar(1)[0] ?? 0;

      const err = valorFuturoReal - pred1Paso;
      errores.push(err);
      sumaCuadrados += err * err;
      sumaAbs += Math.abs(err);
      sumaSesgo += err;

      const denomSmape = Math.abs(valorFuturoReal) + Math.abs(pred1Paso);
      if (denomSmape > 0) {
        sumaSmape += (200 * Math.abs(err)) / denomSmape;
      }
    }

    const numPasos = errores.length;
    const rmse = Math.sqrt(sumaCuadrados / numPasos);
    const mae = sumaAbs / numPasos;
    const sesgo = sumaSesgo / numPasos;
    const smape = sumaSmape / numPasos;

    comparativaModelos.push({
      metodo: cand.metodo,
      nombreLegible: cand.nombre,
      evaluado: true,
      rmseOutSampleCentimos: Math.round(rmse),
      maeOutSampleCentimos: Math.round(mae),
      sesgoMedioOutSampleCentimos: Math.round(sesgo),
      smapeOutSamplePorcentaje: Number(smape.toFixed(2)),
      pasosValidados: numPasos,
      erroresOutSample: errores,
    });
  }

  const evaluados = comparativaModelos.filter(
    (m): m is EvaluacionBacktestingModelo & { rmseOutSampleCentimos: number; maeOutSampleCentimos: number } =>
      m.evaluado && m.rmseOutSampleCentimos !== null && m.maeOutSampleCentimos !== null,
  );

  evaluados.sort((a, b) => {
    if (a.rmseOutSampleCentimos !== b.rmseOutSampleCentimos) {
      return a.rmseOutSampleCentimos - b.rmseOutSampleCentimos;
    }
    if (a.maeOutSampleCentimos !== b.maeOutSampleCentimos) {
      return a.maeOutSampleCentimos - b.maeOutSampleCentimos;
    }
    return ORDEN_PARSIMONIA[a.metodo] - ORDEN_PARSIMONIA[b.metodo];
  });

  const ganador = evaluados[0]!;
  // Reentrenar el modelo ganador con TODA la serie observada [1..N]
  const modeloFinalReentrenado = ajustarPorMetodo(serie, ganador.metodo);

  return {
    particionCronologicaEstricta: true,
    totalObservaciones: n,
    indiceCorteInicialEntrenamiento: corteInicial,
    pasosValidacionOutSample: pasosValidacion,
    metodoSeleccionado: ganador.metodo,
    justificacionSeleccion: `Seleccionado ${ganador.nombreLegible} mediante validación temporal walk-forward fuera de muestra (${pasosValidacion} cortes cronológicos sin mezclar pasado y futuro) por menor RMSE = S/ ${(ganador.rmseOutSampleCentimos / 100).toFixed(2)} (MAE = S/ ${(ganador.maeOutSampleCentimos / 100).toFixed(2)}).`,
    comparativaModelos,
    modeloFinalReentrenado,
    erroresOutSampleGanador: ganador.erroresOutSample,
  };
}

export type { ParametrosModeloEstimado };
