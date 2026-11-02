/**
 * Aritmética monetaria exacta.
 *
 * REGLA: todo monto se representa como un ENTERO en la unidad menor de su
 * moneda (PEN → céntimos). Nunca se usan números de punto flotante para dinero.
 *   S/ 12.50  →  1250
 *   CLP 10.000 →  10000 (CLP no tiene decimales)
 *
 * Los cálculos intermedios que involucran tasas o proporciones usan BigInt y
 * redondeo "mitad al par" (bancario) para no introducir sesgo sistemático.
 */
import { MONEDA_PRINCIPAL, obtenerMoneda } from './monedas';

/** Entero en unidad menor de la moneda correspondiente. */
export type MontoMinor = number;

export class ErrorMonto extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorMonto';
  }
}

export function assertMontoEntero(valor: unknown, campo = 'monto'): asserts valor is MontoMinor {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    throw new ErrorMonto(`${campo} debe ser un entero seguro en unidad menor; se recibió ${String(valor)}`);
  }
}

const RE_MONTO = /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * Convierte un texto decimal ("1,234.50", "-12.5", "300") a unidad menor.
 * Es estricto: si el texto tiene más decimales de los que admite la moneda,
 * lanza un error en lugar de redondear silenciosamente.
 */
export function parsearMonto(texto: string, moneda: string = MONEDA_PRINCIPAL): MontoMinor {
  const { decimales } = obtenerMoneda(moneda);
  const limpio = texto.trim();
  const m = RE_MONTO.exec(limpio);
  if (!m) throw new ErrorMonto(`Formato de monto inválido: "${texto}"`);
  const signo = m[1] === '-' ? -1n : 1n;
  const entero = (m[2] ?? '0').replaceAll(',', '');
  const fraccion = m[3] ?? '';
  if (fraccion.length > decimales) {
    throw new ErrorMonto(
      `"${texto}" tiene ${fraccion.length} decimales; ${moneda} admite como máximo ${decimales}`,
    );
  }
  const minor = BigInt(entero + fraccion.padEnd(decimales, '0')) * signo;
  return bigintASeguro(minor, texto);
}

/** Representación decimal canónica sin símbolo: 123450 → "1234.50". */
export function aTextoDecimal(monto: MontoMinor, moneda: string = MONEDA_PRINCIPAL): string {
  assertMontoEntero(monto);
  const { decimales } = obtenerMoneda(moneda);
  const negativo = monto < 0;
  const abs = String(Math.abs(monto)).padStart(decimales + 1, '0');
  const ent = decimales === 0 ? abs : abs.slice(0, -decimales);
  const frac = decimales === 0 ? '' : '.' + abs.slice(-decimales);
  return (negativo ? '-' : '') + ent + frac;
}

/** Formato de presentación: 123450 → "S/ 1,234.50"; -500 → "-S/ 5.00". */
export function formatearMonto(monto: MontoMinor, moneda: string = MONEDA_PRINCIPAL): string {
  const { simbolo } = obtenerMoneda(moneda);
  const texto = aTextoDecimal(Math.abs(monto), moneda);
  const [ent = '0', frac] = texto.split('.');
  const conMiles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${monto < 0 ? '-' : ''}${simbolo} ${conMiles}${frac !== undefined ? '.' + frac : ''}`;
}

/** Suma exacta con verificación de desbordamiento. */
export function sumarMontos(montos: readonly MontoMinor[]): MontoMinor {
  let total = 0n;
  for (const m of montos) {
    assertMontoEntero(m);
    total += BigInt(m);
  }
  return bigintASeguro(total, 'suma');
}

/** División entera con redondeo mitad al par (bancario). den > 0. */
export function dividirMitadPar(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new ErrorMonto('Denominador debe ser positivo');
  const q = num / den; // trunca hacia cero
  const r = num % den;
  if (r === 0n) return q;
  const dobleResto = (r < 0n ? -r : r) * 2n;
  const signo = num < 0n ? -1n : 1n;
  if (dobleResto > den) return q + signo;
  if (dobleResto < den) return q;
  // Exactamente a la mitad: al par.
  return q % 2n === 0n ? q : q + signo;
}

const RE_TASA = /^\d+(?:\.\d{1,12})?$/;

/** Valida una tasa de cambio expresada como texto decimal positivo ("3.7450"). */
export function validarTasa(tasa: string): void {
  if (!RE_TASA.test(tasa) || /^0+(?:\.0+)?$/.test(tasa)) {
    throw new ErrorMonto(`Tasa de cambio inválida: "${tasa}" (use texto decimal positivo, p. ej. "3.7450")`);
  }
}

/**
 * Convierte un monto entre monedas.
 * @param tasa unidades de la moneda destino por 1 unidad de la moneda origen,
 *             como texto decimal (p. ej. USD→PEN "3.7450").
 * Redondeo mitad al par a la unidad menor de destino.
 */
export function convertirMonto(
  monto: MontoMinor,
  monedaOrigen: string,
  monedaDestino: string,
  tasa: string,
): MontoMinor {
  assertMontoEntero(monto);
  validarTasa(tasa);
  const dOrigen = obtenerMoneda(monedaOrigen).decimales;
  const dDestino = obtenerMoneda(monedaDestino).decimales;
  const [ent = '0', frac = ''] = tasa.split('.');
  const numTasa = BigInt(ent + frac);
  const escalaTasa = 10n ** BigInt(frac.length);
  // destinoMinor = monto / 10^dO * tasa * 10^dD
  const num = BigInt(monto) * numTasa * 10n ** BigInt(dDestino);
  const den = escalaTasa * 10n ** BigInt(dOrigen);
  return bigintASeguro(dividirMitadPar(num, den), 'conversión');
}

/**
 * Reparte un total entero según pesos no negativos, garantizando que la suma
 * de las partes sea EXACTAMENTE el total (método del mayor resto; empates por
 * orden de aparición). Útil para dividir gastos compartidos o imputaciones.
 */
export function repartirProporcional(total: MontoMinor, pesos: readonly number[]): MontoMinor[] {
  assertMontoEntero(total, 'total');
  if (pesos.length === 0) throw new ErrorMonto('Se requiere al menos un peso');
  for (const p of pesos) {
    if (!Number.isSafeInteger(p) || p < 0) throw new ErrorMonto('Los pesos deben ser enteros no negativos');
  }
  const sumaPesos = pesos.reduce((a, b) => a + BigInt(b), 0n);
  if (sumaPesos === 0n) throw new ErrorMonto('La suma de pesos no puede ser cero');
  const signo = total < 0 ? -1n : 1n;
  const abs = BigInt(Math.abs(total));
  const base = pesos.map((p) => (abs * BigInt(p)) / sumaPesos);
  const restos = pesos.map((p, i) => ({ i, resto: (abs * BigInt(p)) % sumaPesos }));
  let faltante = abs - base.reduce((a, b) => a + b, 0n);
  restos.sort((a, b) => (a.resto === b.resto ? a.i - b.i : a.resto > b.resto ? -1 : 1));
  for (const { i } of restos) {
    if (faltante === 0n) break;
    base[i] = (base[i] ?? 0n) + 1n;
    faltante -= 1n;
  }
  return base.map((b) => Number(b * signo));
}

/** Reparte un total en n partes iguales (las primeras reciben el remanente). */
export function repartirEquitativo(total: MontoMinor, partes: number): MontoMinor[] {
  if (!Number.isSafeInteger(partes) || partes < 1) throw new ErrorMonto('partes debe ser un entero ≥ 1');
  return repartirProporcional(total, Array.from({ length: partes }, () => 1));
}

function bigintASeguro(v: bigint, contexto: string): MontoMinor {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ErrorMonto(`Monto fuera de rango seguro (${contexto})`);
  }
  return Number(v);
}
