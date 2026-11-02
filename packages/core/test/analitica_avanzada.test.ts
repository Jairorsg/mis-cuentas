import { describe, expect, it } from 'vitest';
import {
  calcularCurvaLiquidezYDesviacion,
  calcularHeatmapTemporal,
  calcularParetoCategorias,
  calcularWaterfallFlujo,
  filtrarMovimientosAnalitica,
  type CategoriaPersonalizada,
  type CuentaMetodo,
  type MovimientoFinanciero,
} from '../src/index';

const AUDITORIA_BASE = {
  origen: 'MANUAL' as const,
  creadoEn: '2026-03-01T17:00:00.000Z',
  actualizadoEn: '2026-03-01T17:00:00.000Z',
  eliminadoEn: null,
  version: 1,
  loteImportacionId: null,
};

const CATEGORIAS_PRUEBA: CategoriaPersonalizada[] = [
  {
    id: 'cat-sueldo',
    nombre: 'Sueldo',
    naturaleza: 'INGRESO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-vivienda',
    nombre: 'Vivienda y servicios',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-alimentacion',
    nombre: 'Alimentación',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-transporte',
    nombre: 'Transporte',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-ocio',
    nombre: 'Ocio',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
  {
    id: 'cat-salud',
    nombre: 'Salud',
    naturaleza: 'GASTO',
    padreId: null,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
];

const CUENTAS_PRUEBA: CuentaMetodo[] = [
  {
    id: 'cta-bcp',
    nombre: 'Débito BCP',
    tipo: 'TARJETA_DEBITO',
    moneda: 'PEN',
    institucion: 'BCP',
    color: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  },
];

function crearMov(
  parcial: Partial<MovimientoFinanciero> & Pick<MovimientoFinanciero, 'id' | 'tipo' | 'montoCentimos' | 'fechaMovimiento'>,
): MovimientoFinanciero {
  return {
    id: parcial.id,
    fechaMovimiento: parcial.fechaMovimiento,
    horaMovimiento: parcial.horaMovimiento ?? '12:00',
    registradoEn: '2026-03-01T17:00:00.000Z',
    tipo: parcial.tipo,
    categoriaId: parcial.categoriaId ?? 'cat-alimentacion',
    subcategoriaId: parcial.subcategoriaId ?? null,
    cuentaId: parcial.cuentaId ?? 'cta-bcp',
    cuentaDestinoId: parcial.cuentaDestinoId ?? null,
    esPagoTarjeta: parcial.esPagoTarjeta ?? false,
    montoCentimos: parcial.montoCentimos,
    moneda: 'PEN',
    etiquetas: parcial.etiquetas ?? [],
    descripcion: parcial.descripcion ?? null,
    eventoId: parcial.eventoId ?? null,
    estado: parcial.estado ?? 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  };
}

describe('Fase 3: Analítica Financiera Avanzada', () => {
  it('1. Waterfall Chart: garantiza exclusividad mutua (gasto de evento jamás se suma como variable ni fijo) y cuadre exacto', () => {
    const movimientos: MovimientoFinanciero[] = [
      // Ingreso: S/ 5,000.00
      crearMov({
        id: 'm-ing-1',
        tipo: 'INGRESO',
        categoriaId: 'cat-sueldo',
        montoCentimos: 500_000,
        fechaMovimiento: '2026-03-01',
      }),
      // Gasto fijo por categoría "Vivienda y servicios": S/ 1,200.00
      crearMov({
        id: 'm-fijo-1',
        tipo: 'GASTO',
        categoriaId: 'cat-vivienda',
        montoCentimos: 120_000,
        fechaMovimiento: '2026-03-02',
      }),
      // Gasto variable (Alimentación sin evento): S/ 650.00
      crearMov({
        id: 'm-var-1',
        tipo: 'GASTO',
        categoriaId: 'cat-alimentacion',
        montoCentimos: 65_000,
        fechaMovimiento: '2026-03-03',
      }),
      // Gasto asociado a un evento (incluso si su categoría fuera Vivienda o Alimentación y tuviera #Fijo): S/ 900.00
      // DEBE clasificarse EXCLUSIVAMENTE en GASTOS_EVENTOS y nunca duplicarse en GASTOS_VARIABLES ni GASTOS_FIJOS.
      crearMov({
        id: 'm-ev-1',
        tipo: 'GASTO',
        categoriaId: 'cat-alimentacion',
        eventoId: 'ev-viaje-sur',
        etiquetas: ['#Fijo', '#Viaje'],
        montoCentimos: 90_000,
        fechaMovimiento: '2026-03-04',
      }),
    ];

    const res = calcularWaterfallFlujo({
      movimientos,
      categorias: CATEGORIAS_PRUEBA,
    });

    expect(res.estado).toBe('OK');
    if (res.estado !== 'OK') return;

    expect(res.datos.ingresosCentimos).toBe(500_000);
    expect(res.datos.gastosFijosCentimos).toBe(120_000);
    expect(res.datos.gastosVariablesCentimos).toBe(65_000);
    expect(res.datos.gastosEventosCentimos).toBe(90_000);
    expect(res.datos.totalGastosCentimos).toBe(275_000);
    expect(res.datos.flujoNetoCentimos).toBe(225_000);
    expect(res.datos.cuadreExacto).toBe(true);

    // Verificar que cada ID de gasto esté en un único segmento de gasto
    const pasoFijo = res.datos.pasos.find((p) => p.segmento === 'GASTOS_FIJOS')!;
    const pasoVar = res.datos.pasos.find((p) => p.segmento === 'GASTOS_VARIABLES')!;
    const pasoEv = res.datos.pasos.find((p) => p.segmento === 'GASTOS_EVENTOS')!;

    expect(pasoFijo.movimientosIds).toEqual(['m-fijo-1']);
    expect(pasoVar.movimientosIds).toEqual(['m-var-1']);
    expect(pasoEv.movimientosIds).toEqual(['m-ev-1']);
  });

  it('2. Heatmap Temporal: ubica correctamente día y hora en America/Lima y calcula frecuencia, total y promedio sin inventar horarios', () => {
    // 2026-03-02 es Lunes; 2026-03-08 es Domingo
    const movimientos: MovimientoFinanciero[] = [
      crearMov({
        id: 'g-1',
        tipo: 'GASTO',
        montoCentimos: 2_000,
        fechaMovimiento: '2026-03-02', // Lunes (índice 0)
        horaMovimiento: '08:15', // Hora 8
      }),
      crearMov({
        id: 'g-2',
        tipo: 'GASTO',
        montoCentimos: 4_000,
        fechaMovimiento: '2026-03-09', // Lunes siguiente (índice 0)
        horaMovimiento: '08:45', // Hora 8
      }),
      crearMov({
        id: 'g-3',
        tipo: 'GASTO',
        montoCentimos: 10_000,
        fechaMovimiento: '2026-03-08', // Domingo (índice 6)
        horaMovimiento: '21:30', // Hora 21
      }),
    ];

    const res = calcularHeatmapTemporal(movimientos);
    expect(res.estado).toBe('OK');
    if (res.estado !== 'OK') return;

    expect(res.datos.zonaHoraria).toBe('America/Lima');
    expect(res.datos.totalOperacionesGasto).toBe(3);
    expect(res.datos.importeTotalGastoCentimos).toBe(16_000);
    expect(res.datos.celdas).toHaveLength(7 * 24);

    // Lunes a las 08h: 2 operaciones, total 6000, promedio 3000
    const celdaLunes08 = res.datos.celdas.find((c) => c.diaSemanaIndice === 0 && c.hora === 8)!;
    expect(celdaLunes08.diaSemanaNombre).toBe('Lunes');
    expect(celdaLunes08.frecuencia).toBe(2);
    expect(celdaLunes08.importeTotalCentimos).toBe(6_000);
    expect(celdaLunes08.importePromedioCentimos).toBe(3_000);
    expect(celdaLunes08.movimientosIds).toEqual(['g-1', 'g-2']);

    // Domingo a las 21h: 1 operación, total 10000, promedio 10000
    const celdaDomingo21 = res.datos.celdas.find((c) => c.diaSemanaIndice === 6 && c.hora === 21)!;
    expect(celdaDomingo21.diaSemanaNombre).toBe('Domingo');
    expect(celdaDomingo21.frecuencia).toBe(1);
    expect(celdaDomingo21.importeTotalCentimos).toBe(10_000);
    expect(celdaDomingo21.importePromedioCentimos).toBe(10_000);

    // Suma de todas las celdas == total registrado
    const sumaCeldas = res.datos.celdas.reduce((acc, c) => acc + c.importeTotalCentimos, 0);
    expect(sumaCeldas).toBe(16_000);
  });

  it('3. Curva de Liquidez y Desviación: advierte historial insuficiente (< 7 días) y calcula E[S(t)] = t*μ y σ*√t con historial válido', () => {
    // Caso A: solo 3 días de cobertura -> HISTORIAL_INSUFICIENTE en bandasEstadisticas
    const movsCortos: MovimientoFinanciero[] = [
      crearMov({ id: 'c1', tipo: 'GASTO', montoCentimos: 1_000, fechaMovimiento: '2026-03-01' }),
      crearMov({ id: 'c2', tipo: 'GASTO', montoCentimos: 2_000, fechaMovimiento: '2026-03-03' }),
    ];
    const resCorto = calcularCurvaLiquidezYDesviacion({
      movimientos: movsCortos,
      cuentas: CUENTAS_PRUEBA,
    });
    expect(resCorto.estado).toBe('OK');
    if (resCorto.estado === 'OK') {
      expect(resCorto.datos.bandasEstadisticas.estado).toBe('HISTORIAL_INSUFICIENTE');
      expect(resCorto.datos.tieneSaldoBancarioRealCompleto).toBe(false);
      // Sin saldo inicial, el saldo bancario al cierre es null (no se finge un saldo bancario)
      expect(resCorto.datos.puntosDiarios[0]!.saldoBancarioRealCierreCentimos).toBeNull();
      expect(resCorto.datos.puntosDiarios[0]!.gastoAcumuladoEsperadoCentimos).toBeNull();
    }

    // Caso B: 7 días de cobertura con gastos conocidos
    // Gastos diarios en céntimos: [1000, 2000, 3000, 1000, 2000, 3000, 2000] -> suma = 14000, μ = 2000
    // Varianza muestral = ((1000^2)*2 + 0 + (1000^2)*2) / 6 = 4_000_000 / 6 => σ = sqrt(666666.6667) ≈ 816.49658
    const gastos7Dias: MovimientoFinanciero[] = [
      crearMov({ id: 'd1', tipo: 'GASTO', montoCentimos: 1_000, fechaMovimiento: '2026-03-01' }),
      crearMov({ id: 'd2', tipo: 'GASTO', montoCentimos: 2_000, fechaMovimiento: '2026-03-02' }),
      crearMov({ id: 'd3', tipo: 'GASTO', montoCentimos: 3_000, fechaMovimiento: '2026-03-03' }),
      crearMov({ id: 'd4', tipo: 'GASTO', montoCentimos: 1_000, fechaMovimiento: '2026-03-04' }),
      crearMov({ id: 'd5', tipo: 'GASTO', montoCentimos: 2_000, fechaMovimiento: '2026-03-05' }),
      crearMov({ id: 'd6', tipo: 'GASTO', montoCentimos: 3_000, fechaMovimiento: '2026-03-06' }),
      crearMov({ id: 'd7', tipo: 'GASTO', montoCentimos: 2_000, fechaMovimiento: '2026-03-07' }),
    ];

    const resValido = calcularCurvaLiquidezYDesviacion({
      movimientos: gastos7Dias,
      cuentas: CUENTAS_PRUEBA,
    });
    expect(resValido.estado).toBe('OK');
    if (resValido.estado !== 'OK') return;

    expect(resValido.datos.bandasEstadisticas.estado).toBe('OK');
    if (resValido.datos.bandasEstadisticas.estado !== 'OK') return;

    expect(resValido.datos.bandasEstadisticas.datos.mediaDiariaCentimos).toBe(2_000);
    expect(resValido.datos.bandasEstadisticas.datos.desviacionEstandarDiariaCentimos).toBe(816);
    expect(resValido.datos.bandasEstadisticas.datos.notaMetodologica).toContain('no son intervalos de confianza garantizados');

    // En t = 4: E[S(4)] = 4 * 2000 = 8000; σ_acum(4) = σ * sqrt(4) = 2 * σ ≈ 1633
    const puntoT4 = resValido.datos.puntosDiarios[3]!;
    expect(puntoT4.t).toBe(4);
    expect(puntoT4.gastoAcumuladoEsperadoCentimos).toBe(8_000);
    expect(puntoT4.bandaMas1SigmaCentimos).toBe(Math.round(8_000 + Math.sqrt(4_000_000 / 6) * 2));
    expect(puntoT4.bandaMas2SigmaCentimos).toBe(Math.round(8_000 + Math.sqrt(4_000_000 / 6) * 4));
  });

  it('4. Pareto 80/20: ordena descendentemente, calcula porcentajes acumulados e identifica las categorías vitales del 80%', () => {
    // Total = 100_000 (S/ 1,000.00)
    // Vivienda: 50_000 (50%)
    // Alimentación: 32_000 (32%, acum = 82% -> alcanza el 80%)
    // Transporte: 10_000 (10%, acum = 92%)
    // Ocio: 5_000 (5%, acum = 97%)
    // Salud: 3_000 (3%, acum = 100%)
    const movimientos: MovimientoFinanciero[] = [
      crearMov({ id: 'p1', tipo: 'GASTO', categoriaId: 'cat-transporte', montoCentimos: 10_000, fechaMovimiento: '2026-03-01' }),
      crearMov({ id: 'p2', tipo: 'GASTO', categoriaId: 'cat-vivienda', montoCentimos: 50_000, fechaMovimiento: '2026-03-02' }),
      crearMov({ id: 'p3', tipo: 'GASTO', categoriaId: 'cat-salud', montoCentimos: 3_000, fechaMovimiento: '2026-03-03' }),
      crearMov({ id: 'p4', tipo: 'GASTO', categoriaId: 'cat-alimentacion', montoCentimos: 32_000, fechaMovimiento: '2026-03-04' }),
      crearMov({ id: 'p5', tipo: 'GASTO', categoriaId: 'cat-ocio', montoCentimos: 5_000, fechaMovimiento: '2026-03-05' }),
    ];

    const res = calcularParetoCategorias({
      movimientos,
      categorias: CATEGORIAS_PRUEBA,
    });
    expect(res.estado).toBe('OK');
    if (res.estado !== 'OK') return;

    expect(res.datos.totalGastoCentimos).toBe(100_000);
    expect(res.datos.lineaReferenciaPorcentaje).toBe(80);
    expect(res.datos.filas.map((f) => f.nombreCategoria)).toEqual([
      'Vivienda y servicios',
      'Alimentación',
      'Transporte',
      'Ocio',
      'Salud',
    ]);
    expect(res.datos.filas.map((f) => f.porcentajeAcumuladoBp)).toEqual([
      5000,
      8200,
      9200,
      9700,
      10000,
    ]);
    expect(res.datos.categoriasVitales80).toEqual(['Vivienda y servicios', 'Alimentación']);
  });

  it('5. Filtros globales: filtra por periodo, categoría, cuenta, tipo, evento y etiqueta', () => {
    const movimientos: MovimientoFinanciero[] = [
      crearMov({
        id: 'f1',
        tipo: 'GASTO',
        categoriaId: 'cat-alimentacion',
        cuentaId: 'cta-bcp',
        eventoId: 'ev-1',
        etiquetas: ['#ViajeTacna'],
        montoCentimos: 5_000,
        fechaMovimiento: '2026-03-10',
      }),
      crearMov({
        id: 'f2',
        tipo: 'GASTO',
        categoriaId: 'cat-ocio',
        cuentaId: 'cta-bcp',
        eventoId: null,
        etiquetas: ['#Rutina'],
        montoCentimos: 3_000,
        fechaMovimiento: '2026-03-12',
      }),
    ];

    const porEtiqueta = filtrarMovimientosAnalitica(movimientos, {
      modoPeriodo: 'MES',
      mes: '2026-03',
      etiqueta: '#viajetacna',
    });
    expect(porEtiqueta.map((m) => m.id)).toEqual(['f1']);

    const sinEvento = filtrarMovimientosAnalitica(movimientos, {
      modoPeriodo: 'MES',
      mes: '2026-03',
      eventoId: '__SIN_EVENTO__',
    });
    expect(sinEvento.map((m) => m.id)).toEqual(['f2']);
  });
});
