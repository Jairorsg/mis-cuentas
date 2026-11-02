/**
 * Catálogo de referencia de monedas (ISO 4217).
 *
 * Esto NO son datos financieros: es metadata necesaria para representar montos
 * correctamente (cantidad de decimales de la unidad menor). La migración 0001
 * inserta exactamente este mismo catálogo; una prueba garantiza que coincidan.
 */
export interface Moneda {
  readonly codigo: string;
  readonly nombre: string;
  readonly simbolo: string;
  /** Decimales de la unidad menor (PEN = 2 → céntimos; CLP = 0). */
  readonly decimales: number;
}

export const MONEDA_PRINCIPAL = 'PEN' as const;

export const CATALOGO_MONEDAS: readonly Moneda[] = Object.freeze([
  { codigo: 'PEN', nombre: 'Sol peruano', simbolo: 'S/', decimales: 2 },
  { codigo: 'USD', nombre: 'Dólar estadounidense', simbolo: 'US$', decimales: 2 },
  { codigo: 'EUR', nombre: 'Euro', simbolo: '€', decimales: 2 },
  { codigo: 'CLP', nombre: 'Peso chileno', simbolo: 'CLP$', decimales: 0 },
  { codigo: 'BOB', nombre: 'Boliviano', simbolo: 'Bs', decimales: 2 },
  { codigo: 'ARS', nombre: 'Peso argentino', simbolo: 'ARS$', decimales: 2 },
  { codigo: 'BRL', nombre: 'Real brasileño', simbolo: 'R$', decimales: 2 },
  { codigo: 'COP', nombre: 'Peso colombiano', simbolo: 'COL$', decimales: 2 },
  { codigo: 'MXN', nombre: 'Peso mexicano', simbolo: 'MX$', decimales: 2 },
  { codigo: 'GBP', nombre: 'Libra esterlina', simbolo: '£', decimales: 2 },
  { codigo: 'CAD', nombre: 'Dólar canadiense', simbolo: 'CA$', decimales: 2 },
  { codigo: 'CHF', nombre: 'Franco suizo', simbolo: 'CHF', decimales: 2 },
  { codigo: 'JPY', nombre: 'Yen japonés', simbolo: '¥', decimales: 0 },
  { codigo: 'CNY', nombre: 'Yuan chino', simbolo: 'CN¥', decimales: 2 },
]);

const INDICE = new Map(CATALOGO_MONEDAS.map((m) => [m.codigo, m]));

export function obtenerMoneda(codigo: string): Moneda {
  const m = INDICE.get(codigo);
  if (!m) throw new Error(`Moneda desconocida: "${codigo}"`);
  return m;
}

export function esMonedaConocida(codigo: string): boolean {
  return INDICE.has(codigo);
}
