import { describe, expect, it } from 'vitest';
import {
  diferenciaDias,
  esFechaContableValida,
  esOrigenReal,
  fechaContableDe,
  finDeMes,
  historialInsuficiente,
  inicioDeMes,
  mesDe,
  ORIGENES_DATO,
  ORIGENES_REALES,
  sumarDias,
  ZONA_HORARIA,
} from '../src/index';

describe('Fechas en America/Lima y trazabilidad de origen', () => {
  it('calcula la fecha contable en America/Lima (UTC-5) correctamente en bordes de medianoche UTC', () => {
    expect(ZONA_HORARIA).toBe('America/Lima');
    // 2026-11-02T03:30:00Z en UTC sigue siendo 2026-11-01 22:30:00 en Lima
    expect(fechaContableDe('2026-11-02T03:30:00.000Z')).toBe('2026-11-01');
    // 2026-11-02T05:00:00Z ya es 2026-11-02 00:00:00 en Lima
    expect(fechaContableDe('2026-11-02T05:00:00.000Z')).toBe('2026-11-02');
  });

  it('valida fechas reales del calendario incluyendo años bisiestos', () => {
    expect(esFechaContableValida('2024-02-29')).toBe(true);
    expect(esFechaContableValida('2025-02-29')).toBe(false);
    expect(esFechaContableValida('2026-04-31')).toBe(false);
    expect(esFechaContableValida('2026-11-01')).toBe(true);

    expect(inicioDeMes('2026-11-15')).toBe('2026-11-01');
    expect(finDeMes('2024-02-10')).toBe('2024-02-29');
    expect(mesDe('2026-11-15')).toBe('2026-11');
    expect(sumarDias('2026-11-30', 1)).toBe('2026-12-01');
    expect(diferenciaDias('2026-11-01', '2026-11-10')).toBe(9);
  });

  it('separa estrictamente orígenes reales de DERIVADO y PROYECTADO y reporta historial insuficiente', () => {
    expect(ORIGENES_REALES).toEqual(['MANUAL', 'IMPORTADO', 'SINCRONIZADO']);
    expect(ORIGENES_DATO).toEqual(['MANUAL', 'IMPORTADO', 'SINCRONIZADO', 'DERIVADO', 'PROYECTADO']);
    expect(esOrigenReal('MANUAL')).toBe(true);
    expect(esOrigenReal('PROYECTADO')).toBe(false);
    expect(esOrigenReal('DERIVADO')).toBe(false);

    const ins = historialInsuficiente(3, 1, 'meses completos', 'promedio mensual');
    expect(ins.estado).toBe('HISTORIAL_INSUFICIENTE');
    if (ins.estado === 'HISTORIAL_INSUFICIENTE') {
      expect(ins.requerido).toBe(3);
      expect(ins.disponible).toBe(1);
    }
  });
});
