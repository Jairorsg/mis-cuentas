/**
 * Fase 4 — Detección Automática de Anomalías y Gastos Atípicos.
 *
 * Implementa:
 *  - Z-score clásico: Z = (x - μ) / σ
 *  - Z-score robusto (Mediana y MAD): Z_rob = 0.6745 * (x - Mediana) / MAD
 *  - Umbral inicial configurable (por defecto Z > 2.0)
 *  - Comparación por categoría cuando existan suficientes observaciones comparables
 *    (n_cat >= 5) y respaldo contra el conjunto global de gastos.
 *
 * REGLA IMPORTANTE:
 *  - Una alerta estadística señala una desviación respecto al patrón histórico
 *    propio para facilitar la revisión; NO constituye fraude ni error contable.
 */
import { type MontoMinor, sumarMontos } from '../dinero';
import { mesDe } from '../fechas';
import type { CategoriaPersonalizada, MovimientoFinanciero } from '../libro';
import { historialInsuficiente, type ResultadoAnalitico } from '../origen';
import { construirSerieTemporalDiaria } from './preparacion';

export const UMBRAL_Z_DEFAULT = 2.0;
export const MINIMO_OBS_COMPARACION_CATEGORIA = 5;

export type TipoAlertaAnomalia =
  | 'GASTO_INUSUALMENTE_ELEVADO'
  | 'INCREMENTO_ANORMAL_CATEGORIA'
  | 'CAMBIO_PATRON_DIARIO'
  | 'REQUIERE_REVISION';

export interface AlertaAnomaliaFinanciera {
  id: string;
  tipoAlerta: TipoAlertaAnomalia;
  severidad: 'MODERADA' | 'ALTA';
  fecha: string;
  movimientoId: string | null;
  categoriaId: string | null;
  nombreCategoria: string;
  montoObservadoCentimos: MontoMinor;
  referenciaMediaCentimos: MontoMinor;
  referenciaMedianaCentimos: MontoMinor;
  zScoreClasico: number;
  zScoreRobustoMad: number;
  ambitoComparacion: 'CATEGORIA' | 'GLOBAL_GASTOS' | 'SERIE_DIARIA' | 'HISTORIAL_MENSUAL_CATEGORIA';
  observacionesComparables: number;
  titulo: string;
  explicacionEstadistica: string;
  notaNoEsFraude: string;
}

export interface ResultadoDeteccionAnomalias {
  origen: 'DERIVADO';
  umbralZConfigurado: number;
  totalGastosAnalizados: number;
  alertas: AlertaAnomaliaFinanciera[];
  resumenPorTipo: {
    gastosInusualmenteElevados: number;
    incrementosAnormalesCategoria: number;
    cambiosPatronDiario: number;
    movimientosRequierenRevision: number;
  };
  notaMetodologica: string;
}

const NOTA_NO_FRAUDE =
  'Nota: Esta es una alerta estadística descriptiva frente a tu propio historial; sugiere revisar el registro, pero no implica fraude ni error.';

/** Calcula la mediana exacta de un arreglo numérico no vacío. */
export function calcularMediana(valores: readonly number[]): number {
  if (valores.length === 0) return 0;
  const ord = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(ord.length / 2);
  if (ord.length % 2 === 1) {
    return ord[mitad]!;
  }
  return (ord[mitad - 1]! + ord[mitad]!) / 2;
}

/** Calcula Media, Desviación Estándar, Mediana y MAD (Median Absolute Deviation). */
export function calcularEstadisticosClásicoYRobusto(valores: readonly number[]): {
  media: number;
  sigma: number;
  mediana: number;
  mad: number;
} {
  const n = valores.length;
  if (n === 0) {
    return { media: 0, sigma: 0, mediana: 0, mad: 0 };
  }
  const media = valores.reduce((a, b) => a + b, 0) / n;
  const varianza =
    n > 1 ? valores.reduce((acc, v) => acc + (v - media) * (v - media), 0) / (n - 1) : 0;
  const sigma = Math.sqrt(varianza);
  const mediana = calcularMediana(valores);
  const desviacionesAbs = valores.map((v) => Math.abs(v - mediana));
  const mad = calcularMediana(desviacionesAbs);
  return { media, sigma, mediana, mad };
}

/**
 * Calcula tanto el Z-score clásico como el Z-score robusto basado en Mediana y MAD:
 *  - Z_clásico = (x - μ) / σ
 *  - Z_robusto = 0.6745 * (x - Mediana) / MAD
 */
export function calcularPuntajesZ(
  valor: number,
  est: { media: number; sigma: number; mediana: number; mad: number },
): { zClasico: number; zRobusto: number } {
  const zClasico = est.sigma > 0 ? (valor - est.media) / est.sigma : 0;
  let zRobusto = 0;
  if (est.mad > 0) {
    zRobusto = (0.6745 * (valor - est.mediana)) / est.mad;
  } else if (est.sigma > 0) {
    // Si MAD == 0 (más del 50% de observaciones tienen el mismo monto exacto), respaldamos con escala clásica
    zRobusto = zClasico;
  }
  return {
    zClasico: Number(zClasico.toFixed(2)),
    zRobusto: Number(zRobusto.toFixed(2)),
  };
}

/**
 * Ejecuta el detector automático de anomalías sobre el historial real de gastos.
 */
export function detectarAnomaliasFinancieras(params: {
  movimientos: readonly MovimientoFinanciero[];
  categorias: readonly CategoriaPersonalizada[];
  umbralZ?: number;
  periodoMesFoco?: string;
}): ResultadoAnalitico<ResultadoDeteccionAnomalias> {
  const umbralZ =
    params.umbralZ !== undefined && params.umbralZ > 0
      ? params.umbralZ
      : UMBRAL_Z_DEFAULT;

  const gastos = params.movimientos.filter(
    (m) => m.estado === 'ACTIVO' && m.tipo === 'GASTO' && m.montoCentimos > 0,
  );

  if (gastos.length < 5) {
    return historialInsuficiente(
      5,
      gastos.length,
      'gastos reales registrados',
      'detectar anomalías estadísticas (Z-score clásico y Z-score robusto MAD)',
    );
  }

  const mapaCategorias = new Map(params.categorias.map((c) => [c.id, c.nombre]));
  const montosGlobales = gastos.map((g) => g.montoCentimos);
  const estGlobal = calcularEstadisticosClásicoYRobusto(montosGlobales);

  // Agrupar gastos por categoría para comparación contextual cuando n_cat >= 5
  const gastosPorCategoria = new Map<string, MovimientoFinanciero[]>();
  for (const g of gastos) {
    const cid = g.categoriaId ?? 'sin_categoria';
    const arr = gastosPorCategoria.get(cid) ?? [];
    arr.push(g);
    gastosPorCategoria.set(cid, arr);
  }

  const estadisticosPorCategoria = new Map<
    string,
    ReturnType<typeof calcularEstadisticosClásicoYRobusto>
  >();
  for (const [cid, lista] of gastosPorCategoria.entries()) {
    if (lista.length >= MINIMO_OBS_COMPARACION_CATEGORIA) {
      estadisticosPorCategoria.set(
        cid,
        calcularEstadisticosClásicoYRobusto(lista.map((x) => x.montoCentimos)),
      );
    }
  }

  const alertas: AlertaAnomaliaFinanciera[] = [];

  // 1. Detección de gastos individuales inusualmente elevados (por categoría si n_cat >= 5, o global)
  for (const g of gastos) {
    const cid = g.categoriaId ?? 'sin_categoria';
    const nombreCat = mapaCategorias.get(cid) ?? 'Sin categoría';
    const estCat = estadisticosPorCategoria.get(cid);
    const usarCat = estCat !== undefined;
    const estRef = estCat ?? estGlobal;
    const nComp = usarCat ? (gastosPorCategoria.get(cid)?.length ?? gastos.length) : gastos.length;

    const { zClasico, zRobusto } = calcularPuntajesZ(g.montoCentimos, estRef);
    const zMax = Math.max(zClasico, zRobusto);

    if (zMax > umbralZ && g.montoCentimos > estRef.media) {
      const severidad = zMax >= umbralZ + 1.0 ? 'ALTA' : 'MODERADA';
      alertas.push({
        id: `anom-gasto-${g.id}`,
        tipoAlerta: 'GASTO_INUSUALMENTE_ELEVADO',
        severidad,
        fecha: g.fechaMovimiento,
        movimientoId: g.id,
        categoriaId: g.categoriaId,
        nombreCategoria: nombreCat,
        montoObservadoCentimos: g.montoCentimos,
        referenciaMediaCentimos: Math.round(estRef.media),
        referenciaMedianaCentimos: Math.round(estRef.mediana),
        zScoreClasico: zClasico,
        zScoreRobustoMad: zRobusto,
        ambitoComparacion: usarCat ? 'CATEGORIA' : 'GLOBAL_GASTOS',
        observacionesComparables: nComp,
        titulo: `Gasto inusualmente elevado en ${nombreCat}${g.descripcion ? ` (${g.descripcion})` : ''}`,
        explicacionEstadistica: `El importe supera el umbral Z > ${umbralZ.toFixed(1)} (Z clásico = ${zClasico}, Z robusto MAD = ${zRobusto}) comparado con ${nComp} observaciones de ${usarCat ? `la categoría "${nombreCat}"` : 'tu historial general'}.`,
        notaNoEsFraude: NOTA_NO_FRAUDE,
      });
    }
  }

  // 2. Detección de incrementos anormales por categoría (comparando gasto por mes o por semana de cada categoría)
  for (const [cid, lista] of gastosPorCategoria.entries()) {
    const nombreCat = mapaCategorias.get(cid) ?? 'Sin categoría';
    const porMes = new Map<string, MontoMinor[]>();
    for (const g of lista) {
      const m = mesDe(g.fechaMovimiento);
      const arr = porMes.get(m) ?? [];
      arr.push(g.montoCentimos);
      porMes.set(m, arr);
    }
    if (porMes.size >= 3) {
      const mesesOrdenados = [...porMes.keys()].sort();
      const totalesMensuales = mesesOrdenados.map((m) => sumarMontos(porMes.get(m) ?? []));
      const mesEvaluado =
        params.periodoMesFoco && porMes.has(params.periodoMesFoco)
          ? params.periodoMesFoco
          : mesesOrdenados[mesesOrdenados.length - 1]!;
      const totalMesEval = sumarMontos(porMes.get(mesEvaluado) ?? []);
      const estMeses = calcularEstadisticosClásicoYRobusto(totalesMensuales);
      const { zClasico, zRobusto } = calcularPuntajesZ(totalMesEval, estMeses);
      const zMax = Math.max(zClasico, zRobusto);

      if (zMax > umbralZ && totalMesEval > estMeses.media) {
        alertas.push({
          id: `anom-cat-mes-${cid}-${mesEvaluado}`,
          tipoAlerta: 'INCREMENTO_ANORMAL_CATEGORIA',
          severidad: zMax >= umbralZ + 1.0 ? 'ALTA' : 'MODERADA',
          fecha: `${mesEvaluado}-01`,
          movimientoId: null,
          categoriaId: cid,
          nombreCategoria: nombreCat,
          montoObservadoCentimos: totalMesEval,
          referenciaMediaCentimos: Math.round(estMeses.media),
          referenciaMedianaCentimos: Math.round(estMeses.mediana),
          zScoreClasico: zClasico,
          zScoreRobustoMad: zRobusto,
          ambitoComparacion: 'HISTORIAL_MENSUAL_CATEGORIA',
          observacionesComparables: porMes.size,
          titulo: `Incremento anormal mensual en categoría ${nombreCat} (${mesEvaluado})`,
          explicacionEstadistica: `El acumulado de ${nombreCat} en ${mesEvaluado} registra Z = ${zClasico} (Z robusto = ${zRobusto}) frente a los ${porMes.size} meses con historial en esta categoría.`,
          notaNoEsFraude: NOTA_NO_FRAUDE,
        });
      }
    }
  }

  // 3. Detección de cambios relevantes en el patrón diario (picos agregados diarios)
  const serieDiaria = construirSerieTemporalDiaria({
    movimientos: gastos,
    tipo: 'GASTO',
  });
  if (serieDiaria && serieDiaria.puntos.length >= 7) {
    const diasActivos = serieDiaria.puntos.filter((p) => p.valorCentimos > 0);
    if (diasActivos.length >= 5) {
      const estDiario = calcularEstadisticosClásicoYRobusto(
        diasActivos.map((p) => p.valorCentimos),
      );
      for (const p of diasActivos) {
        const { zClasico, zRobusto } = calcularPuntajesZ(p.valorCentimos, estDiario);
        const zMax = Math.max(zClasico, zRobusto);
        if (zMax > umbralZ && p.cantidadOperaciones >= 2) {
          alertas.push({
            id: `anom-patron-dia-${p.fecha}`,
            tipoAlerta: 'CAMBIO_PATRON_DIARIO',
            severidad: zMax >= umbralZ + 1.0 ? 'ALTA' : 'MODERADA',
            fecha: p.fecha,
            movimientoId: null,
            categoriaId: null,
            nombreCategoria: 'Agregado diario',
            montoObservadoCentimos: p.valorCentimos,
            referenciaMediaCentimos: Math.round(estDiario.media),
            referenciaMedianaCentimos: Math.round(estDiario.mediana),
            zScoreClasico: zClasico,
            zScoreRobustoMad: zRobusto,
            ambitoComparacion: 'SERIE_DIARIA',
            observacionesComparables: diasActivos.length,
            titulo: `Pico en el patrón de gasto diario (${p.fecha})`,
            explicacionEstadistica: `El gasto conjunto del día (${p.cantidadOperaciones} operaciones) se desvía del patrón diario habitual con Z = ${zClasico} y Z robusto = ${zRobusto}.`,
            notaNoEsFraude: NOTA_NO_FRAUDE,
          });
        }
      }
    }
  }

  // 4. Movimientos que requieren revisión (posibles registros repetidos el mismo día, cuenta, categoría e importe exacto)
  const agrupadosHuella = new Map<string, MovimientoFinanciero[]>();
  for (const g of gastos) {
    const llave = `${g.fechaMovimiento}|${g.cuentaId}|${g.categoriaId ?? ''}|${g.montoCentimos}`;
    const arr = agrupadosHuella.get(llave) ?? [];
    arr.push(g);
    agrupadosHuella.set(llave, arr);
  }
  for (const [, grupo] of agrupadosHuella.entries()) {
    if (grupo.length >= 2) {
      const muestra = grupo[0]!;
      const cid = muestra.categoriaId ?? 'sin_categoria';
      const nombreCat = mapaCategorias.get(cid) ?? 'Sin categoría';
      const { zClasico, zRobusto } = calcularPuntajesZ(muestra.montoCentimos, estGlobal);
      alertas.push({
        id: `anom-rev-dup-${muestra.id}`,
        tipoAlerta: 'REQUIERE_REVISION',
        severidad: 'MODERADA',
        fecha: muestra.fechaMovimiento,
        movimientoId: muestra.id,
        categoriaId: muestra.categoriaId,
        nombreCategoria: nombreCat,
        montoObservadoCentimos: muestra.montoCentimos,
        referenciaMediaCentimos: Math.round(estGlobal.media),
        referenciaMedianaCentimos: Math.round(estGlobal.mediana),
        zScoreClasico: zClasico,
        zScoreRobustoMad: zRobusto,
        ambitoComparacion: 'GLOBAL_GASTOS',
        observacionesComparables: gastos.length,
        titulo: `${grupo.length} movimientos de igual importe el mismo día (${muestra.fechaMovimiento})`,
        explicacionEstadistica: `Se observaron ${grupo.length} registros activos de S/ ${(muestra.montoCentimos / 100).toFixed(2)} en ${nombreCat} en la misma fecha y cuenta. Se sugiere verificar si corresponden a operaciones distintas.`,
        notaNoEsFraude: NOTA_NO_FRAUDE,
      });
    }
  }

  // Ordenar por severidad y luego por mayor |Z|
  alertas.sort((a, b) => {
    if (a.severidad !== b.severidad) return a.severidad === 'ALTA' ? -1 : 1;
    return (
      Math.max(b.zScoreClasico, b.zScoreRobustoMad) -
      Math.max(a.zScoreClasico, a.zScoreRobustoMad)
    );
  });

  const fechas = gastos.map((g) => g.fechaMovimiento).sort();
  return {
    estado: 'OK',
    origen: 'DERIVADO',
    ventana: {
      desde: fechas[0]!,
      hasta: fechas[fechas.length - 1]!,
      observaciones: gastos.length,
    },
    datos: {
      origen: 'DERIVADO',
      umbralZConfigurado: umbralZ,
      totalGastosAnalizados: gastos.length,
      alertas,
      resumenPorTipo: {
        gastosInusualmenteElevados: alertas.filter(
          (a) => a.tipoAlerta === 'GASTO_INUSUALMENTE_ELEVADO',
        ).length,
        incrementosAnormalesCategoria: alertas.filter(
          (a) => a.tipoAlerta === 'INCREMENTO_ANORMAL_CATEGORIA',
        ).length,
        cambiosPatronDiario: alertas.filter(
          (a) => a.tipoAlerta === 'CAMBIO_PATRON_DIARIO',
        ).length,
        movimientosRequierenRevision: alertas.filter(
          (a) => a.tipoAlerta === 'REQUIERE_REVISION',
        ).length,
      },
      notaMetodologica:
        'Combina Z-score paramétrico (media y desviación estándar) y Z-score robusto (mediana y MAD escalado por 0.6745) para resistir el enmascaramiento por valores extremos.',
    },
  };
}
