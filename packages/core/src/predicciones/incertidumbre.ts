/**
 * Fase 4 — Cuantificación de Incertidumbre, Análisis de Residuos e Intervalos del 95 %.
 *
 * Distingue explícitamente entre:
 *  1. Intervalo de Confianza del 95 % de la MEDIA esperada:
 *     Cuantifica la incertidumbre de estimación del valor medio esperado E[Y_futuro],
 *     cuyo error estándar decrece con √n.
 *  2. Intervalo de Predicción del 95 % de la OBSERVACIÓN / ACUMULADO futuro:
 *     Cuantifica el rango donde caerá la realización futura real Y_{n+1..n+H},
 *     sumando la varianza de estimación de la media MÁS la varianza irreducible
 *     de las innovaciones futuras ε_{n+1}, ..., ε_{n+H} y el factor de propagación
 *     temporal del método seleccionado. Siempre es más ancho que el IC de la media.
 */
import type { MontoMinor } from '../dinero';
import type { MetodoPronostico, ParametrosModeloEstimado } from './estimacion';

export interface DiagnosticoResiduos {
  cantidadResiduos: number;
  /** Media de los residuos e_t = y_t - ŷ_t (sesgo medio en céntimos). */
  mediaResiduosCentimos: number;
  /** Varianza muestral del error s²_ε (en céntimos²). */
  varianzaErrorCentimos2: number;
  /** Desviación estándar del error de predicción σ̂_ε (en céntimos). */
  desviacionErrorCentimos: number;
  /** Coeficiente de asimetría muestral (skewness). */
  asimetriaSkewness: number;
  /** Exceso de curtosis muestral (kurtosis - 3). */
  excesoCurtosis: number;
  /** Indica si la distribución de residuos es compatible con normalidad aproximada. */
  esAproximadamenteNormal: boolean;
  /** Indica si existe un sesgo sistemático relevante (|mediaResiduos| > 0.35 * σ̂_ε). */
  sesgoSignificativoDetectado: boolean;
  /** Indica si la media de los días recientes cambió > 35 % respecto al tramo previo. */
  cambioComportamientoReciente: boolean;
  descripcionCambioComportamiento: string | null;
}

export interface RangoIntervalo95 {
  inferiorCentimos: MontoMinor;
  superiorCentimos: MontoMinor;
  semiamplitudPromedioCentimos: MontoMinor;
}

export interface Intervalos95Proyeccion {
  nivelConfianza: 0.95;
  horizonteDias: number;
  /**
   * Intervalo de Confianza del 95 % de la MEDIA esperada del total al cierre.
   * Refleja solo la incertidumbre sobre los parámetros estimados (NO incluye el ruido futuro día a día).
   */
  intervaloConfianzaMedia95: RangoIntervalo95;
  /**
   * Intervalo de Predicción del 95 % de la REALIZACIÓN futura al cierre.
   * Incluye la incertidumbre de estimación + la varianza irreducible de las futuras observaciones
   * + ajuste por sesgo/asimetría empírica de residuos.
   */
  intervaloPrediccionObservacion95: RangoIntervalo95;
  diagnosticoResiduos: DiagnosticoResiduos;
  explicacionDiferenciaIntervalos: string;
  advertenciasIncertidumbre: string[];
}

/** Valor crítico aproximado de t-Student al 97.5% bilateral (95% confianza) para gl grados de libertad. */
export function valorCriticoT95(gradosLibertad: number): number {
  const gl = Math.max(1, Math.floor(gradosLibertad));
  const tabla: Record<number, number> = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    12: 2.179,
    15: 2.131,
    20: 2.086,
    25: 2.06,
    30: 2.042,
    40: 2.021,
    60: 2.0,
  };
  if (tabla[gl]) return tabla[gl]!;
  if (gl > 60) return 1.96;
  // Interpolación simple
  const llaves = Object.keys(tabla)
    .map(Number)
    .sort((a, b) => a - b);
  for (let i = 0; i < llaves.length - 1; i++) {
    const k1 = llaves[i]!;
    const k2 = llaves[i + 1]!;
    if (gl > k1 && gl < k2) {
      const w = (gl - k1) / (k2 - k1);
      return tabla[k1]! + w * (tabla[k2]! - tabla[k1]!);
    }
  }
  return 1.96;
}

/** Analiza los residuos de predicción y detecta posibles sesgos y cambios de comportamiento. */
export function analizarResiduosYComportamiento(
  residuosInSample: readonly number[],
  erroresOutSample: readonly number[],
  serieCompleta: readonly number[],
): DiagnosticoResiduos {
  // Combinamos priorizando los errores fuera de muestra (validación histórica real)
  // complementados con los residuos in-sample si la ventana out-of-sample es corta.
  const muestraResiduos =
    erroresOutSample.length >= 6
      ? [...erroresOutSample]
      : [...residuosInSample, ...erroresOutSample];

  const m = muestraResiduos.length;
  if (m === 0) {
    return {
      cantidadResiduos: 0,
      mediaResiduosCentimos: 0,
      varianzaErrorCentimos2: 0,
      desviacionErrorCentimos: 0,
      asimetriaSkewness: 0,
      excesoCurtosis: 0,
      esAproximadamenteNormal: false,
      sesgoSignificativoDetectado: false,
      cambioComportamientoReciente: false,
      descripcionCambioComportamiento: null,
    };
  }

  const media = muestraResiduos.reduce((a, b) => a + b, 0) / m;
  const varianza =
    m > 1
      ? muestraResiduos.reduce((acc, r) => acc + (r - media) * (r - media), 0) / (m - 1)
      : muestraResiduos[0]! * muestraResiduos[0]!;
  const sigma = Math.sqrt(Math.max(0, varianza));

  let skewness = 0;
  let excessKurtosis = 0;
  if (sigma > 0 && m >= 4) {
    const m3 =
      muestraResiduos.reduce((acc, r) => acc + Math.pow((r - media) / sigma, 3), 0) / m;
    const m4 =
      muestraResiduos.reduce((acc, r) => acc + Math.pow((r - media) / sigma, 4), 0) / m;
    skewness = Number(m3.toFixed(3));
    excessKurtosis = Number((m4 - 3).toFixed(3));
  }

  const esAproximadamenteNormal = Math.abs(skewness) <= 1.0 && Math.abs(excessKurtosis) <= 2.0;
  const sesgoSignificativoDetectado = sigma > 0 ? Math.abs(media) > 0.35 * sigma : false;

  // Detectar cambio de comportamiento reciente comparando el último tercio (mínimo 3 días, máx 7) con el tramo anterior
  let cambioComportamientoReciente = false;
  let descripcionCambioComportamiento: string | null = null;
  const n = serieCompleta.length;
  if (n >= 7) {
    const ventanaReciente = Math.min(7, Math.max(3, Math.floor(n / 3)));
    const tramoPrevio = serieCompleta.slice(0, n - ventanaReciente);
    const tramoReciente = serieCompleta.slice(n - ventanaReciente);
    const mediaPrevia = tramoPrevio.reduce((a, b) => a + b, 0) / tramoPrevio.length;
    const mediaReciente = tramoReciente.reduce((a, b) => a + b, 0) / tramoReciente.length;

    if (mediaPrevia > 0) {
      const cambioRelativo = (mediaReciente - mediaPrevia) / mediaPrevia;
      if (Math.abs(cambioRelativo) >= 0.35) {
        cambioComportamientoReciente = true;
        const direccion = cambioRelativo > 0 ? 'incremento' : 'reducción';
        descripcionCambioComportamiento = `Se detectó un ${direccion} del ${Math.abs(
          cambioRelativo * 100,
        ).toFixed(1)}% en el ritmo diario de los últimos ${ventanaReciente} días frente al tramo previo.`;
      }
    }
  }

  return {
    cantidadResiduos: m,
    mediaResiduosCentimos: Math.round(media),
    varianzaErrorCentimos2: Math.round(varianza),
    desviacionErrorCentimos: Math.round(sigma),
    asimetriaSkewness: skewness,
    excesoCurtosis: excessKurtosis,
    esAproximadamenteNormal,
    sesgoSignificativoDetectado,
    cambioComportamientoReciente,
    descripcionCambioComportamiento,
  };
}

/**
 * Calcula los Intervalos del 95 % para el monto total proyectado al cierre:
 *  - `intervaloConfianzaMedia95`: incertidumbre sobre la MEDIA esperada.
 *  - `intervaloPrediccionObservacion95`: incertidumbre sobre la OBSERVACIÓN / SUMA futura real.
 */
export function calcularIntervalos95Proyeccion(params: {
  acumuladoRealActualCentimos: MontoMinor;
  pronosticoRestanteCentimos: MontoMinor;
  horizonteDias: number;
  serieObservada: readonly number[];
  residuosInSample: readonly number[];
  erroresOutSample: readonly number[];
  parametrosModelo: ParametrosModeloEstimado;
}): Intervalos95Proyeccion {
  const {
    acumuladoRealActualCentimos,
    pronosticoRestanteCentimos,
    horizonteDias,
    serieObservada,
    residuosInSample,
    erroresOutSample,
    parametrosModelo,
  } = params;

  const diagnostico = analizarResiduosYComportamiento(
    residuosInSample,
    erroresOutSample,
    serieObservada,
  );
  const totalPuntual = acumuladoRealActualCentimos + pronosticoRestanteCentimos;

  if (horizonteDias <= 0) {
    return {
      nivelConfianza: 0.95,
      horizonteDias: 0,
      intervaloConfianzaMedia95: {
        inferiorCentimos: totalPuntual,
        superiorCentimos: totalPuntual,
        semiamplitudPromedioCentimos: 0,
      },
      intervaloPrediccionObservacion95: {
        inferiorCentimos: totalPuntual,
        superiorCentimos: totalPuntual,
        semiamplitudPromedioCentimos: 0,
      },
      diagnosticoResiduos: diagnostico,
      explicacionDiferenciaIntervalos:
        'El periodo ha concluido (horizonte H = 0 días restantes); el valor proyectado coincide con el acumulado real.',
      advertenciasIncertidumbre: [],
    };
  }

  const n = Math.max(2, serieObservada.length);
  const gl = Math.max(1, n - 2);
  const tCrit = valorCriticoT95(gl);
  const sigma = diagnostico.desviacionErrorCentimos;

  // 1. Error estándar de la MEDIA acumulada en H pasos:
  //    Para el promedio diario μ̂, SE(μ̂) = σ / √n => para la suma esperada de H días, SE_media(H) = H * (σ / √n)
  //    (con factor adicional en MCO cuando se extrapola fuera del centro de la muestra).
  let factorExtrapolacionMedia = 1;
  if (parametrosModelo.metodo === 'MCO') {
    const tBarra = (n + 1) / 2;
    const tMedioFuturo = n + (horizonteDias + 1) / 2;
    const sxx = (n * (n * n - 1)) / 12;
    if (sxx > 0) {
      factorExtrapolacionMedia = Math.sqrt(
        1 + (n * Math.pow(tMedioFuturo - tBarra, 2)) / sxx,
      );
    }
  }
  const seMediaAcumulada =
    horizonteDias * (sigma / Math.sqrt(n)) * factorExtrapolacionMedia;
  const semiMedia = Math.round(tCrit * seMediaAcumulada);

  const icMediaInf = Math.max(
    acumuladoRealActualCentimos,
    totalPuntual - semiMedia,
  );
  const icMediaSup = totalPuntual + semiMedia;

  // 2. Varianza del ERROR DE PREDICCIÓN de la suma futura Y_{n+1} + ... + Y_{n+H}:
  //    Incluye la varianza irreducible de las H innovaciones futuras más la amplificación
  //    por actualización de nivel/tendencia (según el método: SES, Holt, Holt-Winters o MCO)
  //    más la varianza de estimación de la media.
  const alpha = parametrosModelo.alpha ?? 0.3;
  const beta = parametrosModelo.beta ?? 0;
  const metodo: MetodoPronostico = parametrosModelo.metodo;

  let varInnovacionesSuma = 0;
  for (let h = 1; h <= horizonteDias; h++) {
    // Coeficiente de propagación de una innovación sobre los pasos restantes del horizonte
    const pasosRestantes = horizonteDias - h;
    let cH = 1;
    if (metodo === 'SES') {
      cH = 1 + pasosRestantes * alpha;
    } else if (metodo === 'HOLT' || metodo === 'HOLT_WINTERS') {
      cH =
        1 +
        pasosRestantes * alpha +
        alpha * beta * ((pasosRestantes * (pasosRestantes + 1)) / 2);
    }
    varInnovacionesSuma += sigma * sigma * cH * cH;
  }

  const sePrediccionTotal = Math.sqrt(
    varInnovacionesSuma + seMediaAcumulada * seMediaAcumulada,
  );

  // Si hay asimetría positiva fuerte en gastos (colas derechas pesadas), ajustamos asimétricamente el borde superior
  const factorColaSuperior =
    diagnostico.asimetriaSkewness > 0.5
      ? 1 + Math.min(0.35, diagnostico.asimetriaSkewness * 0.15)
      : 1;
  const factorColaInferior =
    diagnostico.asimetriaSkewness > 0.5
      ? Math.max(0.75, 1 - diagnostico.asimetriaSkewness * 0.1)
      : 1;

  // Incorporar posible corrección de sesgo en el borde correspondiente
  const ajusteSesgoSup =
    diagnostico.mediaResiduosCentimos > 0
      ? horizonteDias * diagnostico.mediaResiduosCentimos
      : 0;
  const ajusteSesgoInf =
    diagnostico.mediaResiduosCentimos < 0
      ? horizonteDias * Math.abs(diagnostico.mediaResiduosCentimos)
      : 0;

  const margenSupPred = Math.max(
    semiMedia + 1,
    Math.round(tCrit * sePrediccionTotal * factorColaSuperior + ajusteSesgoSup),
  );
  const margenInfPred = Math.max(
    semiMedia,
    Math.round(tCrit * sePrediccionTotal * factorColaInferior + ajusteSesgoInf),
  );

  const ipObsInf = Math.max(
    acumuladoRealActualCentimos,
    totalPuntual - margenInfPred,
  );
  const ipObsSup = totalPuntual + margenSupPred;
  const semiPredPromedio = Math.round((ipObsSup - ipObsInf) / 2);

  const advertenciasIncertidumbre: string[] = [];
  if (!diagnostico.esAproximadamenteNormal) {
    advertenciasIncertidumbre.push(
      `Los residuos históricos presentan asimetría (${diagnostico.asimetriaSkewness}) o curtosis (${diagnostico.excesoCurtosis}) no gaussiana; se aplicó ajuste de cola en el intervalo de predicción.`,
    );
  }
  if (diagnostico.sesgoSignificativoDetectado) {
    advertenciasIncertidumbre.push(
      `Se detectó un sesgo medio de validación de S/ ${(diagnostico.mediaResiduosCentimos / 100).toFixed(2)} por día, incorporado en la amplitud del intervalo.`,
    );
  }
  if (diagnostico.cambioComportamientoReciente && diagnostico.descripcionCambioComportamiento) {
    advertenciasIncertidumbre.push(diagnostico.descripcionCambioComportamiento);
  }

  return {
    nivelConfianza: 0.95,
    horizonteDias,
    intervaloConfianzaMedia95: {
      inferiorCentimos: icMediaInf,
      superiorCentimos: icMediaSup,
      semiamplitudPromedioCentimos: Math.round((icMediaSup - icMediaInf) / 2),
    },
    intervaloPrediccionObservacion95: {
      inferiorCentimos: ipObsInf,
      superiorCentimos: ipObsSup,
      semiamplitudPromedioCentimos: semiPredPromedio,
    },
    diagnosticoResiduos: diagnostico,
    explicacionDiferenciaIntervalos:
      'El Intervalo de Confianza de la Media (95 %) acota dónde se ubica el promedio teórico del ritmo de gasto; el Intervalo de Predicción (95 %) es más amplio porque añade la variabilidad diaria aleatoria de las próximas observaciones.',
    advertenciasIncertidumbre,
  };
}
