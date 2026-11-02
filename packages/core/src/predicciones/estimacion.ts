/**
 * Fase 4 — Modelos de Estimación de Series Temporales Financieras.
 *
 * Implementa de forma matemáticamente diferenciada:
 *  1. MCO (Mínimos Cuadrados Ordinarios / Regresión lineal sobre el tiempo t):
 *     y_t = β_0 + β_1 * t + ε_t, pronóstico: ŷ_{n+h} = max(0, β_0 + β_1 * (n + h)).
 *  2. SES (Suavizamiento Exponencial Simple — solo nivel, sin tendencia ni estacionalidad):
 *     ℓ_t = α * y_t + (1 - α) * ℓ_{t-1}, pronóstico plano: ŷ_{n+h|n} = max(0, ℓ_n).
 *  3. HOLT (Suavizamiento Exponencial Doble de Holt — nivel + tendencia lineal):
 *     ℓ_t = α * y_t + (1 - α) * (ℓ_{t-1} + b_{t-1})
 *     b_t = β* * (ℓ_t - ℓ_{t-1}) + (1 - β*) * b_{t-1}
 *     pronóstico con pendiente: ŷ_{n+h|n} = max(0, ℓ_n + h * b_n).
 *  4. HOLT_WINTERS (Holt-Winters Aditivo — nivel + tendencia + estacionalidad semanal m = 7):
 *     ℓ_t = α * (y_t - s_{t-m}) + (1 - α) * (ℓ_{t-1} + b_{t-1})
 *     b_t = β* * (ℓ_t - ℓ_{t-1}) + (1 - β*) * b_{t-1}
 *     s_t = γ * (y_t - ℓ_{t-1} - b_{t-1}) + (1 - γ) * s_{t-m}
 *     pronóstico: ŷ_{n+h|n} = max(0, ℓ_n + h * b_n + s_{n + h - m * k}).
 */

export const METODOS_PRONOSTICO = ['MCO', 'SES', 'HOLT', 'HOLT_WINTERS'] as const;
export type MetodoPronostico = (typeof METODOS_PRONOSTICO)[number];

export interface ParametrosModeloEstimado {
  metodo: MetodoPronostico;
  nombreLegible: string;
  formulaResumen: string;
  /** Hiperparámetros y estados finales ajustados sobre la muestra de entrenamiento. */
  alpha?: number;
  beta?: number;
  gamma?: number;
  periodoEstacional?: number;
  interceptoBeta0?: number;
  pendienteBeta1?: number;
  nivelFinal?: number;
  tendenciaFinal?: number;
  factoresEstacionalesFinales?: number[];
}

export interface ModeloSerieAjustado {
  parametros: ParametrosModeloEstimado;
  /** Valores ajustados dentro de muestra (1-step ahead in-sample). */
  ajustadosInSample: number[];
  /** Residuos dentro de muestra e_t = y_t - ŷ_{t|t-1}. */
  residuosInSample: number[];
  /** Pronostica para horizontes h = 1, 2, ..., H (devuelve array de longitud H). */
  pronosticar: (horizonteH: number) => number[];
}

/**
 * 1. Mínimos Cuadrados Ordinarios (MCO): y_t = β_0 + β_1 * t, t = 1..n.
 */
export function ajustarMCO(serie: readonly number[]): ModeloSerieAjustado {
  const n = serie.length;
  if (n === 0) {
    throw new Error('ajustarMCO requiere al menos 1 observación.');
  }
  const tMedia = (n + 1) / 2;
  const yMedia = serie.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const t = i + 1;
    const dt = t - tMedia;
    num += dt * (serie[i]! - yMedia);
    den += dt * dt;
  }

  const beta1 = den > 0 ? num / den : 0;
  const beta0 = yMedia - beta1 * tMedia;

  const ajustadosInSample: number[] = [];
  const residuosInSample: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i + 1;
    const yHat = Math.max(0, beta0 + beta1 * t);
    ajustadosInSample.push(yHat);
    residuosInSample.push(serie[i]! - yHat);
  }

  return {
    parametros: {
      metodo: 'MCO',
      nombreLegible: 'Mínimos Cuadrados Ordinarios (MCO)',
      formulaResumen: 'ŷ_{n+h} = max(0, β₀ + β₁·(n + h))',
      interceptoBeta0: beta0,
      pendienteBeta1: beta1,
      nivelFinal: beta0 + beta1 * n,
      tendenciaFinal: beta1,
    },
    ajustadosInSample,
    residuosInSample,
    pronosticar: (horizonteH: number) => {
      const out: number[] = [];
      for (let h = 1; h <= horizonteH; h++) {
        out.push(Math.max(0, beta0 + beta1 * (n + h)));
      }
      return out;
    },
  };
}

/**
 * 2. Suavizamiento Exponencial Simple (SES):
 *    ℓ_t = α * y_t + (1 - α) * ℓ_{t-1}, pronóstico plano ŷ_{n+h|n} = ℓ_n.
 *    Optimiza α ∈ {0.05, 0.10, ..., 0.95} minimizando SSE de 1 paso adelante en entrenamiento.
 */
export function ajustarSES(serie: readonly number[]): ModeloSerieAjustado {
  const n = serie.length;
  if (n === 0) {
    throw new Error('ajustarSES requiere al menos 1 observación.');
  }

  const evaluarAlpha = (alpha: number) => {
    let nivel = serie[0]!;
    const ajustados: number[] = [nivel];
    const residuos: number[] = [0];
    let sse = 0;
    for (let t = 1; t < n; t++) {
      const pred = Math.max(0, nivel);
      const err = serie[t]! - pred;
      ajustados.push(pred);
      residuos.push(err);
      sse += err * err;
      nivel = alpha * serie[t]! + (1 - alpha) * nivel;
    }
    return { alpha, nivelFinal: Math.max(0, nivel), ajustados, residuos, sse };
  };

  let mejor = evaluarAlpha(0.3);
  for (let paso = 1; paso <= 19; paso++) {
    const alpha = Number((paso * 0.05).toFixed(2));
    const cand = evaluarAlpha(alpha);
    if (cand.sse < mejor.sse) {
      mejor = cand;
    }
  }

  return {
    parametros: {
      metodo: 'SES',
      nombreLegible: 'Suavizamiento Exponencial Simple (SES)',
      formulaResumen: 'ℓ_t = α·y_t + (1-α)·ℓ_{t-1} ; ŷ_{n+h|n} = ℓ_n',
      alpha: mejor.alpha,
      nivelFinal: mejor.nivelFinal,
      tendenciaFinal: 0,
    },
    ajustadosInSample: mejor.ajustados,
    residuosInSample: mejor.residuos.slice(1),
    pronosticar: (horizonteH: number) => Array.from({ length: horizonteH }, () => mejor.nivelFinal),
  };
}

/**
 * 3. Método Lineal de Holt (nivel + tendencia lineal, sin estacionalidad):
 *    ℓ_t = α * y_t + (1 - α) * (ℓ_{t-1} + b_{t-1})
 *    b_t = β* * (ℓ_t - ℓ_{t-1}) + (1 - β*) * b_{t-1}
 *    ŷ_{n+h|n} = max(0, ℓ_n + h * b_n).
 */
export function ajustarHolt(serie: readonly number[]): ModeloSerieAjustado {
  const n = serie.length;
  if (n < 2) {
    return ajustarSES(serie);
  }

  // Inicialización estándar: nivel inicial y_1 y pendiente promedio inicial de los primeros puntos
  const kInit = Math.min(4, n);
  const b0 = (serie[kInit - 1]! - serie[0]!) / Math.max(1, kInit - 1);
  const l0 = serie[0]!;

  const evaluarPar = (alpha: number, beta: number) => {
    let nivel = l0;
    let tend = b0;
    const ajustados: number[] = [Math.max(0, nivel)];
    const residuos: number[] = [0];
    let sse = 0;

    for (let t = 1; t < n; t++) {
      const pred = Math.max(0, nivel + tend);
      const err = serie[t]! - pred;
      ajustados.push(pred);
      residuos.push(err);
      sse += err * err;

      const nivelPrev = nivel;
      nivel = alpha * serie[t]! + (1 - alpha) * (nivelPrev + tend);
      tend = beta * (nivel - nivelPrev) + (1 - beta) * tend;
    }

    return { alpha, beta, nivelFinal: nivel, tendenciaFinal: tend, ajustados, residuos, sse };
  };

  const rejillaAlpha = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const rejillaBeta = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5];

  let mejor = evaluarPar(0.3, 0.1);
  for (const a of rejillaAlpha) {
    for (const b of rejillaBeta) {
      const cand = evaluarPar(a, b);
      if (cand.sse < mejor.sse) {
        mejor = cand;
      }
    }
  }

  return {
    parametros: {
      metodo: 'HOLT',
      nombreLegible: 'Método de Holt con Tendencia Lineal',
      formulaResumen: 'ℓ_t = α·y_t + (1-α)(ℓ_{t-1}+b_{t-1}) ; b_t = β*(ℓ_t-ℓ_{t-1})+(1-β*)b_{t-1} ; ŷ_{n+h|n} = ℓ_n + h·b_n',
      alpha: mejor.alpha,
      beta: mejor.beta,
      nivelFinal: mejor.nivelFinal,
      tendenciaFinal: mejor.tendenciaFinal,
    },
    ajustadosInSample: mejor.ajustados,
    residuosInSample: mejor.residuos.slice(1),
    pronosticar: (horizonteH: number) => {
      const out: number[] = [];
      for (let h = 1; h <= horizonteH; h++) {
        out.push(Math.max(0, mejor.nivelFinal + h * mejor.tendenciaFinal));
      }
      return out;
    },
  };
}

/**
 * 4. Método de Holt-Winters Aditivo con Estacionalidad Semanal (m = 7).
 *    Requiere al menos 2 ciclos completos (n >= 2 * m = 14 observaciones) para
 *    inicializar nivel, tendencia e índices estacionales sin inventar datos.
 */
export function ajustarHoltWintersAditivo(
  serie: readonly number[],
  periodoEstacional = 7,
): ModeloSerieAjustado {
  const m = periodoEstacional;
  const n = serie.length;
  if (n < 2 * m) {
    throw new Error(
      `Holt-Winters con estacionalidad m=${m} requiere al menos ${2 * m} observaciones en entrenamiento (recibidas: ${n}).`,
    );
  }

  // Inicialización clásica con los dos primeros ciclos completos (semana 1 y semana 2)
  const mediaCiclo1 = serie.slice(0, m).reduce((a, b) => a + b, 0) / m;
  const mediaCiclo2 = serie.slice(m, 2 * m).reduce((a, b) => a + b, 0) / m;
  const l0 = mediaCiclo1;
  const b0 = (mediaCiclo2 - mediaCiclo1) / m;

  // Índices estacionales iniciales centrados a suma 0
  const estacionalesInit: number[] = [];
  for (let j = 0; j < m; j++) {
    const s1 = serie[j]! - mediaCiclo1;
    const s2 = serie[m + j]! - mediaCiclo2;
    estacionalesInit.push((s1 + s2) / 2);
  }
  const mediaEst = estacionalesInit.reduce((a, b) => a + b, 0) / m;
  for (let j = 0; j < m; j++) {
    estacionalesInit[j] = estacionalesInit[j]! - mediaEst;
  }

  const evaluarTriple = (alpha: number, beta: number, gamma: number) => {
    let nivel = l0;
    let tend = b0;
    const sHistory = [...estacionalesInit];
    const ajustados: number[] = [];
    const residuos: number[] = [];
    let sse = 0;

    for (let t = 0; t < n; t++) {
      const sPrev = sHistory[t]!; // En t, el estacional de hace m pasos está en índice t
      const pred = Math.max(0, nivel + tend + sPrev);
      const err = serie[t]! - pred;
      ajustados.push(pred);
      if (t >= m) {
        residuos.push(err);
        sse += err * err;
      }

      const nivelPrev = nivel;
      nivel = alpha * (serie[t]! - sPrev) + (1 - alpha) * (nivelPrev + tend);
      tend = beta * (nivel - nivelPrev) + (1 - beta) * tend;
      const sNuevo = gamma * (serie[t]! - nivelPrev - tend) + (1 - gamma) * sPrev;
      sHistory.push(sNuevo);
    }

    // Últimos m factores estacionales: s_{n-m+1}, ..., s_n
    const ultimosEstacionales = sHistory.slice(sHistory.length - m);
    return {
      alpha,
      beta,
      gamma,
      nivelFinal: nivel,
      tendenciaFinal: tend,
      ultimosEstacionales,
      ajustados,
      residuos,
      sse,
    };
  };

  const rejillaAlpha = [0.15, 0.3, 0.5, 0.7];
  const rejillaBeta = [0.05, 0.15, 0.3];
  const rejillaGamma = [0.1, 0.25, 0.4];

  let mejor = evaluarTriple(0.3, 0.1, 0.2);
  for (const a of rejillaAlpha) {
    for (const b of rejillaBeta) {
      for (const g of rejillaGamma) {
        const cand = evaluarTriple(a, b, g);
        if (cand.sse < mejor.sse) {
          mejor = cand;
        }
      }
    }
  }

  return {
    parametros: {
      metodo: 'HOLT_WINTERS',
      nombreLegible: `Holt-Winters Aditivo (estacionalidad semanal m = ${m})`,
      formulaResumen:
        'ℓ_t = α(y_t-s_{t-m})+(1-α)(ℓ_{t-1}+b_{t-1}) ; b_t = β*(ℓ_t-ℓ_{t-1})+(1-β*)b_{t-1} ; s_t = γ(y_t-ℓ_{t-1}-b_{t-1})+(1-γ)s_{t-m}',
      alpha: mejor.alpha,
      beta: mejor.beta,
      gamma: mejor.gamma,
      periodoEstacional: m,
      nivelFinal: mejor.nivelFinal,
      tendenciaFinal: mejor.tendenciaFinal,
      factoresEstacionalesFinales: mejor.ultimosEstacionales,
    },
    ajustadosInSample: mejor.ajustados,
    residuosInSample: mejor.residuos,
    pronosticar: (horizonteH: number) => {
      const out: number[] = [];
      for (let h = 1; h <= horizonteH; h++) {
        const idxEstacional = (h - 1) % m;
        const sH = mejor.ultimosEstacionales[idxEstacional] ?? 0;
        out.push(Math.max(0, mejor.nivelFinal + h * mejor.tendenciaFinal + sH));
      }
      return out;
    },
  };
}
