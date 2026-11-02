/**
 * Trazabilidad del origen de cada dato.
 *
 * - MANUAL, IMPORTADO, SINCRONIZADO: los únicos orígenes que pueden existir en
 *   la tabla `transacciones` (movimientos reales). La BD lo impone con CHECK.
 * - DERIVADO: resultado matemático de registros reales (saldos, totales,
 *   estadísticas). Se calcula; nunca se guarda como movimiento.
 * - PROYECTADO: estimación futura. Vive en tablas separadas y nunca puede
 *   presentarse como movimiento real.
 */
export const ORIGENES_REALES = ['MANUAL', 'IMPORTADO', 'SINCRONIZADO'] as const;
export type OrigenReal = (typeof ORIGENES_REALES)[number];

export const ORIGENES_DATO = [...ORIGENES_REALES, 'DERIVADO', 'PROYECTADO'] as const;
export type OrigenDato = (typeof ORIGENES_DATO)[number];

export function esOrigenReal(valor: string): valor is OrigenReal {
  return (ORIGENES_REALES as readonly string[]).includes(valor);
}

/**
 * Resultado de cualquier cálculo analítico o proyección. Obliga a que la
 * interfaz distinga entre un resultado válido y la falta de historial,
 * en lugar de rellenar observaciones faltantes.
 */
export type ResultadoAnalitico<T> =
  | {
      estado: 'OK';
      origen: 'DERIVADO' | 'PROYECTADO';
      datos: T;
      /** Descripción del método usado (obligatoria para proyecciones). */
      metodo?: string;
      /** Ventana de datos reales utilizada. */
      ventana?: { desde: string; hasta: string; observaciones: number };
    }
  | {
      estado: 'HISTORIAL_INSUFICIENTE';
      requerido: number;
      disponible: number;
      unidad: string;
      mensaje: string;
    };

export function historialInsuficiente(
  requerido: number,
  disponible: number,
  unidad: string,
  que: string,
): ResultadoAnalitico<never> {
  return {
    estado: 'HISTORIAL_INSUFICIENTE',
    requerido,
    disponible,
    unidad,
    mensaje: `Historial insuficiente para ${que}: se requieren al menos ${requerido} ${unidad} y hay ${disponible}.`,
  };
}
