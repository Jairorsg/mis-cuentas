import { describe, expect, it } from 'vitest';
import {
  aTextoDecimal,
  CATALOGO_MONEDAS,
  convertirMonto,
  dividirMitadPar,
  ErrorMonto,
  esMonedaConocida,
  formatearMonto,
  MONEDA_PRINCIPAL,
  obtenerMoneda,
  parsearMonto,
  repartirEquitativo,
  repartirProporcional,
  sumarMontos,
} from '../src/index';

describe('Módulo de monedas y aritmética monetaria exacta', () => {
  it('define PEN como moneda principal con 2 decimales y símbolo S/', () => {
    expect(MONEDA_PRINCIPAL).toBe('PEN');
    const pen = obtenerMoneda('PEN');
    expect(pen).toEqual({ codigo: 'PEN', nombre: 'Sol peruano', simbolo: 'S/', decimales: 2 });
    expect(esMonedaConocida('PEN')).toBe(true);
    expect(esMonedaConocida('CLP')).toBe(true);
    expect(esMonedaConocida('XXX')).toBe(false);
    expect(CATALOGO_MONEDAS.length).toBeGreaterThanOrEqual(10);
  });

  it('parsea y formatea montos en PEN y monedas sin decimales sin error de punto flotante', () => {
    // Clásico 0.1 + 0.2 en float daría 0.30000000000000004; en céntimos es exacto: 10 + 20 = 30
    const a = parsearMonto('0.10', 'PEN');
    const b = parsearMonto('0.20', 'PEN');
    expect(sumarMontos([a, b])).toBe(30);
    expect(aTextoDecimal(sumarMontos([a, b]), 'PEN')).toBe('0.30');

    expect(parsearMonto('1,234.56', 'PEN')).toBe(123456);
    expect(parsearMonto('-50.05', 'PEN')).toBe(-5005);
    expect(formatearMonto(123456, 'PEN')).toBe('S/ 1,234.56');
    expect(formatearMonto(-505, 'PEN')).toBe('-S/ 5.05');

    // CLP tiene 0 decimales
    expect(parsearMonto('15,000', 'CLP')).toBe(15000);
    expect(formatearMonto(15000, 'CLP')).toBe('CLP$ 15,000');
    expect(() => parsearMonto('150.5', 'CLP')).toThrow(ErrorMonto);
  });

  it('rechaza montos con exceso de decimales o no enteros', () => {
    expect(() => parsearMonto('12.345', 'PEN')).toThrow(ErrorMonto);
    expect(() => parsearMonto('abc', 'PEN')).toThrow(ErrorMonto);
    expect(() => sumarMontos([12.5])).toThrow(ErrorMonto);
  });

  it('aplica redondeo bancario (mitad al par) y conversión de moneda exacta', () => {
    // 5 / 2 = 2.5 -> par más cercano es 2; 7 / 2 = 3.5 -> par más cercano es 4
    expect(dividirMitadPar(5n, 2n)).toBe(2n);
    expect(dividirMitadPar(7n, 2n)).toBe(4n);
    expect(dividirMitadPar(-5n, 2n)).toBe(-2n);
    expect(dividirMitadPar(-7n, 2n)).toBe(-4n);

    // USD 100.00 (10000 cents) a tasa 3.7450 -> PEN 374.50 (37450 céntimos)
    expect(convertirMonto(10000, 'USD', 'PEN', '3.7450')).toBe(37450);
    // CLP 10000 (0 decimales) a tasa 0.00395 -> PEN 39.50 (3950 céntimos)
    expect(convertirMonto(10000, 'CLP', 'PEN', '0.00395')).toBe(3950);
  });

  it('reparte montos proporcional y equitativamente conservando exactamente el total sin perder ni crear céntimos', () => {
    // S/ 1.00 (100 céntimos) entre 3 -> [34, 33, 33], suma = 100
    const partes = repartirEquitativo(100, 3);
    expect(partes).toEqual([34, 33, 33]);
    expect(sumarMontos(partes)).toBe(100);

    // Gasto negativo -100 entre 3 -> [-34, -33, -33], suma = -100
    const partesNeg = repartirEquitativo(-100, 3);
    expect(partesNeg).toEqual([-34, -33, -33]);
    expect(sumarMontos(partesNeg)).toBe(-100);

    const prop = repartirProporcional(1000, [1, 2, 3]);
    expect(sumarMontos(prop)).toBe(1000);
  });
});
