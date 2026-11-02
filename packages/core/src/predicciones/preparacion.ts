/**
 * Fase 4 — Preparación de Observaciones y Agregación Temporal.
 *
 * Construye series temporales diarias estrictamente cronológicas a partir de
 * transacciones reales (origen MANUAL, IMPORTADO o SINCRONIZADO, estado ACTIVO).
 * Nunca rellena con transacciones ficticias ni inventa observaciones antes del
 * inicio de cobertura real.
 */
import { type MontoMinor, sumarMontos } from '../dinero';
import { diferenciaDias, esFechaContableValida, sumarDias } from '../fechas';
import type { MovimientoFinanciero } from '../libro';

export interface PuntoSerieDiaria {
  /** Índice temporal 1-based (t = 1, 2, ..., N). */
  t: number;
  /** Fecha contable en America/Lima ("YYYY-MM-DD"). */
  fecha: string;
  /** Día de la semana (0 = Lunes ... 6 = Domingo). */
  diaSemana: number;
  /** Monto agregado del día en céntimos enteros de PEN. */
  valorCentimos: MontoMinor;
  /** Cantidad de transacciones reales registradas en esa fecha. */
  cantidadOperaciones: number;
}

export interface DiagnosticoCalidadSerie {
  /** Total de días calendario en la ventana observada [desde, hasta]. */
  totalDiasObservados: number;
  /** Días con al menos una operación registrada (> 0 céntimos). */
  diasConActividad: number;
  /** Proporción de días con valor cero (0..1). */
  proporcionCeros: number;
  /** Racha máxima de días consecutivos sin operaciones. */
  rachaMaximaSinActividad: number;
  /** Media muestral diaria en céntimos. */
  mediaDiariaCentimos: number;
  /** Desviación estándar muestral diaria en céntimos. */
  desviacionDiariaCentimos: number;
  /** Coeficiente de variación (σ / μ) cuando μ > 0. */
  coeficienteVariacion: number | null;
  /** Autocorrelación muestral de rezago 1 (ρ_1) para decidir Bootstrap por bloques. */
  autocorrelacionLag1: number;
  /** Autocorrelación muestral de rezago 7 (ρ_7) para evaluar estacionalidad semanal. */
  autocorrelacionLag7: number | null;
  /** Indica si hay suficientes datos para modelos básicos (MCO, SES, Holt): N >= 7 y >= 3 días activos. */
  aptoModelosBasicos: boolean;
  /** Indica si hay suficientes datos para Holt-Winters semanal (m = 7): N >= 21 y >= 7 días activos. */
  aptoHoltWintersSemanal: boolean;
  /** Indica si hay suficientes datos para simulación Monte Carlo: N >= 7 y >= 3 días activos. */
  aptoMonteCarlo: boolean;
  /** Resumen legible sobre la calidad y suficiencia del historial. */
  resumenCalidad: string;
}

export interface SerieTemporalDiaria {
  tipo: 'GASTO' | 'INGRESO';
  desde: string;
  hasta: string;
  puntos: PuntoSerieDiaria[];
  valoresCentimos: MontoMinor[];
  sumaTotalCentimos: MontoMinor;
  diagnostico: DiagnosticoCalidadSerie;
}

function diaSemanaLunesADomingo(fecha: string): number {
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (utcDay + 6) % 7;
}

/** Calcula la autocorrelación muestral de rezago `lag` sobre un vector numérico. */
export function calcularAutocorrelacion(valores: readonly number[], lag: number): number {
  const n = valores.length;
  if (n <= lag + 2) return 0;
  const media = valores.reduce((a, b) => a + b, 0) / n;
  let numerador = 0;
  let denominador = 0;
  for (let i = 0; i < n; i++) {
    const diff = valores[i]! - media;
    denominador += diff * diff;
    if (i >= lag) {
      numerador += diff * (valores[i - lag]! - media);
    }
  }
  if (denominador === 0) return 0;
  return numerador / denominador;
}

/**
 * Construye una serie temporal diaria cronológica a partir de transacciones reales.
 *
 * - Si no se especifica `desdeForzado`, la serie comienza en la primera fecha real
 *   registrada (nunca inventa meses previos vacíos inexistentes).
 * - Si no se especifica `hastaForzado`, termina en la última fecha real o `fechaCorte`.
 */
export function construirSerieTemporalDiaria(params: {
  movimientos: readonly MovimientoFinanciero[];
  tipo: 'GASTO' | 'INGRESO';
  desdeForzado?: string;
  hastaForzado?: string;
  eventoId?: string;
  categoriaId?: string;
}): SerieTemporalDiaria | null {
  const filtrados = params.movimientos.filter((m) => {
    if (m.estado !== 'ACTIVO') return false;
    if (m.tipo !== params.tipo) return false;
    if (!esFechaContableValida(m.fechaMovimiento)) return false;
    if (params.eventoId !== undefined && m.eventoId !== params.eventoId) return false;
    if (
      params.categoriaId !== undefined &&
      m.categoriaId !== params.categoriaId &&
      m.subcategoriaId !== params.categoriaId
    ) {
      return false;
    }
    if (params.hastaForzado && m.fechaMovimiento > params.hastaForzado) return false;
    if (params.desdeForzado && m.fechaMovimiento < params.desdeForzado) return false;
    return true;
  });

  if (filtrados.length === 0) {
    return null;
  }

  const fechasOrdenadas = filtrados.map((m) => m.fechaMovimiento).sort();
  const desde =
    params.desdeForzado && esFechaContableValida(params.desdeForzado)
      ? params.desdeForzado
      : fechasOrdenadas[0]!;
  const hasta =
    params.hastaForzado && esFechaContableValida(params.hastaForzado) && params.hastaForzado >= desde
      ? params.hastaForzado
      : fechasOrdenadas[fechasOrdenadas.length - 1]!;

  const totalDias = diferenciaDias(desde, hasta) + 1;
  if (totalDias <= 0 || totalDias > 3660) {
    return null;
  }

  const porFecha = new Map<string, MontoMinor[]>();
  for (const m of filtrados) {
    const arr = porFecha.get(m.fechaMovimiento) ?? [];
    arr.push(m.montoCentimos);
    porFecha.set(m.fechaMovimiento, arr);
  }

  const puntos: PuntoSerieDiaria[] = [];
  const valoresCentimos: MontoMinor[] = [];
  let diasConActividad = 0;
  let rachaActualCeros = 0;
  let rachaMaximaSinActividad = 0;

  for (let i = 0; i < totalDias; i++) {
    const fecha = sumarDias(desde, i);
    const montosDia = porFecha.get(fecha) ?? [];
    const sumaDia = sumarMontos(montosDia);
    if (sumaDia > 0) {
      diasConActividad += 1;
      rachaActualCeros = 0;
    } else {
      rachaActualCeros += 1;
      if (rachaActualCeros > rachaMaximaSinActividad) {
        rachaMaximaSinActividad = rachaActualCeros;
      }
    }
    puntos.push({
      t: i + 1,
      fecha,
      diaSemana: diaSemanaLunesADomingo(fecha),
      valorCentimos: sumaDia,
      cantidadOperaciones: montosDia.length,
    });
    valoresCentimos.push(sumaDia);
  }

  const sumaTotalCentimos = sumarMontos(valoresCentimos);
  const media = sumaTotalCentimos / totalDias;
  const varianza =
    totalDias > 1
      ? valoresCentimos.reduce((acc, v) => acc + (v - media) * (v - media), 0) / (totalDias - 1)
      : 0;
  const desviacion = Math.sqrt(varianza);
  const proporcionCeros = (totalDias - diasConActividad) / totalDias;
  const autocorrelacionLag1 = calcularAutocorrelacion(valoresCentimos, 1);
  const autocorrelacionLag7 =
    totalDias >= 15 ? calcularAutocorrelacion(valoresCentimos, 7) : null;

  const aptoModelosBasicos = totalDias >= 7 && diasConActividad >= 3;
  const aptoHoltWintersSemanal = totalDias >= 21 && diasConActividad >= 7;
  const aptoMonteCarlo = totalDias >= 7 && diasConActividad >= 3;

  let resumenCalidad: string;
  if (!aptoModelosBasicos) {
    resumenCalidad = `Cobertura insuficiente (${totalDias} día(s) calendario y ${diasConActividad} día(s) con movimiento; mínimo requerido: 7 días de cobertura y 3 días con movimiento).`;
  } else if (aptoHoltWintersSemanal) {
    resumenCalidad = `Cobertura amplia (${totalDias} días, ${diasConActividad} días activos): apta para MCO, SES, Holt y Holt-Winters con estacionalidad semanal (m = 7).`;
  } else {
    resumenCalidad = `Cobertura moderada (${totalDias} días, ${diasConActividad} días activos): apta para MCO, SES, Holt y Monte Carlo; aún insuficiente para estacionalidad semanal Holt-Winters (requiere >= 21 días).`;
  }

  return {
    tipo: params.tipo,
    desde,
    hasta,
    puntos,
    valoresCentimos,
    sumaTotalCentimos,
    diagnostico: {
      totalDiasObservados: totalDias,
      diasConActividad,
      proporcionCeros,
      rachaMaximaSinActividad,
      mediaDiariaCentimos: Math.round(media),
      desviacionDiariaCentimos: Math.round(desviacion),
      coeficienteVariacion: media > 0 ? desviacion / media : null,
      autocorrelacionLag1,
      autocorrelacionLag7,
      aptoModelosBasicos,
      aptoHoltWintersSemanal,
      aptoMonteCarlo,
      resumenCalidad,
    },
  };
}
