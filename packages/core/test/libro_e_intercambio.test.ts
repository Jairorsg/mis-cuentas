import { describe, expect, it } from 'vitest';
import {
  calcularResumenPeriodo,
  calcularSaldosPorCuenta,
  type CategoriaPersonalizada,
  crearMovimientoNuevo,
  type CuentaMetodo,
  exportarLibroAJson,
  exportarMovimientosACsv,
  normalizarEtiquetas,
  previsualizarImportacionCsv,
  previsualizarImportacionJson,
} from '../src/index';

function crearCuentaPrueba(id: string, nombre: string, tipo: CuentaMetodo['tipo']): CuentaMetodo {
  const ahora = '2026-11-01T15:00:00.000Z';
  return {
    id,
    nombre,
    tipo,
    moneda: 'PEN',
    institucion: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: {
      origen: 'MANUAL',
      creadoEn: ahora,
      actualizadoEn: ahora,
      eliminadoEn: null,
      version: 1,
      loteImportacionId: null,
    },
  };
}

function crearCategoriaPrueba(
  id: string,
  nombre: string,
  naturaleza: 'INGRESO' | 'GASTO',
  padreId: string | null = null,
): CategoriaPersonalizada {
  const ahora = '2026-11-01T15:00:00.000Z';
  return {
    id,
    nombre,
    naturaleza,
    padreId,
    icono: null,
    color: null,
    estado: 'ACTIVO',
    auditoria: {
      origen: 'MANUAL',
      creadoEn: ahora,
      actualizadoEn: ahora,
      eliminadoEn: null,
      version: 1,
      loteImportacionId: null,
    },
  };
}

describe('Reglas contables del libro financiero, saldos reales y dashboard', () => {
  const cuentaYape = crearCuentaPrueba('cta-yape', 'Yape', 'YAPE');
  const cuentaDebito = crearCuentaPrueba('cta-debito', 'Tarjeta de débito', 'TARJETA_DEBITO');
  const cuentaTC = crearCuentaPrueba('cta-tc', 'Tarjeta de crédito', 'TARJETA_CREDITO');
  const catSueldo = crearCategoriaPrueba('cat-sueldo', 'Ingresos laborales', 'INGRESO');
  const catComida = crearCategoriaPrueba('cat-comida', 'Alimentación', 'GASTO');
  const subMenu = crearCategoriaPrueba('sub-menu', 'Restaurantes y menú', 'GASTO', 'cat-comida');

  it('no calcula un saldo bancario real cuando la cuenta carece de saldo inicial real', () => {
    const movGasto = crearMovimientoNuevo({
      id: 'm-1',
      fechaMovimiento: '2026-11-01',
      horaMovimiento: '13:15',
      registradoEn: '2026-11-01T18:15:00.000Z',
      tipo: 'GASTO',
      cuentaId: cuentaYape.id,
      categoriaId: catComida.id,
      subcategoriaId: subMenu.id,
      montoCentimos: 2500, // S/ 25.00
      etiquetas: ['Rutina', '#ViajeTacna'],
      descripcion: 'Almuerzo',
    });

    const [saldoYape] = calcularSaldosPorCuenta([cuentaYape], [movGasto]);
    expect(saldoYape).toBeDefined();
    expect(saldoYape!.tieneSaldoInicial).toBe(false);
    expect(saldoYape!.saldoBancarioRealCentimos).toBeNull();
    expect(saldoYape!.estadoSaldo).toBe('SIN_SALDO_INICIAL');
    expect(saldoYape!.flujoMovimientosCentimos).toBe(-2500);
    expect(movGasto.etiquetas).toEqual(['#Rutina', '#ViajeTacna']);
    expect(movGasto.fechaMovimiento).toBe('2026-11-01');
    expect(movGasto.registradoEn).toBe('2026-11-01T18:15:00.000Z');
  });

  it('calcula el saldo bancario real cuando existe saldo inicial y evita doble conteo en transferencias y pagos de tarjeta de crédito', () => {
    // 1. Saldo inicial en Débito: S/ 2,000.00 (200000 céntimos) y en TC: S/ 0.00
    const saldoIniDebito = crearMovimientoNuevo({
      id: 'si-deb',
      fechaMovimiento: '2026-11-01',
      tipo: 'SALDO_INICIAL',
      cuentaId: cuentaDebito.id,
      montoCentimos: 200000,
    });
    const saldoIniTC = crearMovimientoNuevo({
      id: 'si-tc',
      fechaMovimiento: '2026-11-01',
      tipo: 'SALDO_INICIAL',
      cuentaId: cuentaTC.id,
      montoCentimos: 0,
    });

    // 2. Ingreso de sueldo en Débito: S/ 3,500.00 (350000 céntimos)
    const ingreso = crearMovimientoNuevo({
      id: 'm-ing',
      fechaMovimiento: '2026-11-02',
      tipo: 'INGRESO',
      cuentaId: cuentaDebito.id,
      categoriaId: catSueldo.id,
      montoCentimos: 350000,
    });

    // 3. Compra con Tarjeta de Crédito: S/ 150.00 (15000 céntimos) -> Este es el único momento en que se contabiliza el gasto
    const compraTC = crearMovimientoNuevo({
      id: 'm-compra-tc',
      fechaMovimiento: '2026-11-03',
      tipo: 'GASTO',
      cuentaId: cuentaTC.id,
      categoriaId: catComida.id,
      montoCentimos: 15000,
      etiquetas: normalizarEtiquetas(['#Rutina']),
    });

    // 4. Pago de la Tarjeta de Crédito desde Débito: S/ 150.00 (TRANSFERENCIA) -> NO debe incrementar gastos ni ingresos
    const pagoTC = crearMovimientoNuevo({
      id: 'm-pago-tc',
      fechaMovimiento: '2026-11-05',
      tipo: 'TRANSFERENCIA',
      cuentaId: cuentaDebito.id,
      cuentaDestinoId: cuentaTC.id,
      montoCentimos: 15000,
      esPagoTarjeta: true,
      descripcion: 'Pago total de tarjeta de crédito',
    });

    const resumen = calcularResumenPeriodo({
      periodoMes: '2026-11',
      cuentas: [cuentaDebito, cuentaTC],
      categorias: [catSueldo, catComida, subMenu],
      movimientos: [saldoIniDebito, saldoIniTC, ingreso, compraTC, pagoTC],
      presupuestos: [],
    });

    // Ingresos del periodo = S/ 3,500.00; Egresos del periodo = S/ 150.00 (no S/ 300.00)
    expect(resumen.ingresosPeriodoCentimos).toBe(350000);
    expect(resumen.egresosPeriodoCentimos).toBe(15000);
    expect(resumen.flujoNetoPeriodoCentimos).toBe(335000);
    expect(resumen.transferenciasPeriodoCentimos).toBe(15000);
    expect(resumen.pagosTarjetaPeriodoCentimos).toBe(15000);

    // Saldos finales: Débito = 2000 + 3500 - 150 = 5350.00 (535000); TC = 0 - 150 + 150 = 0
    const sDeb = resumen.saldosPorCuenta.find((s) => s.cuentaId === cuentaDebito.id)!;
    const sTC = resumen.saldosPorCuenta.find((s) => s.cuentaId === cuentaTC.id)!;
    expect(sDeb.saldoBancarioRealCentimos).toBe(535000);
    expect(sTC.saldoBancarioRealCentimos).toBe(0);
    expect(resumen.saldoRegistradoConocidoCentimos).toBe(535000);

    // Como no hay movimientos en 2026-10, la comparación con el periodo anterior informa HISTORIAL_INSUFICIENTE
    expect(resumen.comparacionPeriodoAnterior.estado).toBe('HISTORIAL_INSUFICIENTE');
  });

  it('compara correctamente con el periodo anterior cuando existen datos históricos reales', () => {
    const movOctubre = crearMovimientoNuevo({
      id: 'm-oct',
      fechaMovimiento: '2026-10-15',
      tipo: 'GASTO',
      cuentaId: cuentaYape.id,
      categoriaId: catComida.id,
      montoCentimos: 10000, // S/ 100.00 en octubre
    });
    const movNoviembre = crearMovimientoNuevo({
      id: 'm-nov',
      fechaMovimiento: '2026-11-15',
      tipo: 'GASTO',
      cuentaId: cuentaYape.id,
      categoriaId: catComida.id,
      montoCentimos: 12500, // S/ 125.00 en noviembre (+25.00%)
    });

    const resumen = calcularResumenPeriodo({
      periodoMes: '2026-11',
      cuentas: [cuentaYape],
      categorias: [catComida],
      movimientos: [movOctubre, movNoviembre],
      presupuestos: [],
    });

    expect(resumen.comparacionPeriodoAnterior.estado).toBe('OK');
    if (resumen.comparacionPeriodoAnterior.estado === 'OK') {
      expect(resumen.comparacionPeriodoAnterior.datos.egresosAnteriorCentimos).toBe(10000);
      expect(resumen.comparacionPeriodoAnterior.datos.variacionEgresosBp).toBe(2500); // +25.00%
    }
  });
});

describe('Importación y exportación CSV / JSON con validación y detección de duplicados', () => {
  const cuentaYape = crearCuentaPrueba('cta-yape', 'Yape', 'YAPE');
  const catComida = crearCategoriaPrueba('cat-comida', 'Alimentación', 'GASTO');

  it('exporta a CSV y JSON, previsualiza y detecta duplicados por ID y por huella contable', () => {
    const movExistente = crearMovimientoNuevo({
      id: 'mov-original-1',
      fechaMovimiento: '2026-11-01',
      horaMovimiento: '14:00',
      tipo: 'GASTO',
      cuentaId: cuentaYape.id,
      categoriaId: catComida.id,
      montoCentimos: 1850,
      etiquetas: ['#Rutina'],
      descripcion: 'Menú ejecutivo',
    });

    const csvExportado = exportarMovimientosACsv({
      movimientos: [movExistente],
      cuentas: [cuentaYape],
      categorias: [catComida],
      eventos: [],
    });
    expect(csvExportado).toContain('mov-original-1');
    expect(csvExportado).toContain('18.50');

    // Previsualizar el mismo CSV contra [movExistente] debe marcarlo como DUPLICADO_ID
    const prevCsv = previsualizarImportacionCsv({
      contenidoCsv: csvExportado,
      cuentasExistentes: [cuentaYape],
      categoriasExistentes: [catComida],
      eventosExistentes: [],
      movimientosExistentes: [movExistente],
      loteImportacionId: 'lote-1',
    });
    expect(prevCsv.totalFilas).toBe(1);
    expect(prevCsv.duplicadosDetectados).toBe(1);
    expect(prevCsv.filas[0]!.estado).toBe('DUPLICADO_ID');

    // Un CSV con el mismo movimiento pero sin columna id debe detectarse por huella (DUPLICADO_HUELLA)
    const csvSinId = [
      'fechaMovimiento,tipo,cuenta,categoria,montoPEN,descripcion',
      '2026-11-01,GASTO,Yape,Alimentación,18.50,Menú ejecutivo',
      '2026-11-02,GASTO,Yape,Alimentación,32.00,Cena familiar',
    ].join('\n');

    const prevHuella = previsualizarImportacionCsv({
      contenidoCsv: csvSinId,
      cuentasExistentes: [cuentaYape],
      categoriasExistentes: [catComida],
      eventosExistentes: [],
      movimientosExistentes: [movExistente],
      loteImportacionId: 'lote-2',
    });
    expect(prevHuella.totalFilas).toBe(2);
    expect(prevHuella.duplicadosDetectados).toBe(1);
    expect(prevHuella.validosNuevos).toBe(1);
    expect(prevHuella.filas[0]!.estado).toBe('DUPLICADO_HUELLA');
    expect(prevHuella.filas[1]!.estado).toBe('NUEVO');

    // JSON exportación y previsualización
    const jsonExportado = exportarLibroAJson({
      cuentas: [cuentaYape],
      categorias: [catComida],
      eventos: [],
      presupuestos: [],
      movimientos: [movExistente],
    });
    const prevJson = previsualizarImportacionJson({
      contenidoJson: jsonExportado,
      movimientosExistentes: [movExistente],
      loteImportacionId: 'lote-json',
    });
    expect(prevJson.duplicadosDetectados).toBe(1);
  });
});
