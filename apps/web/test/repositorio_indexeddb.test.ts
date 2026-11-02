import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { calcularResumenPeriodo, previsualizarImportacionCsv } from '@mis-cuentas/core';
import { RepositorioIndexedDB } from '../src/persistencia/indexeddb';
import { AdaptadorSupabaseDesacoplado } from '../src/persistencia/puerto';

describe('RepositorioIndexedDB: persistencia real, estados vacíos, auditoría, importación transaccional y cola Supabase', () => {
  it('inicia completamente vacío (0 datos ficticios), permite crear métodos, categorías, movimientos, editar, eliminar y restaurar', async () => {
    const repo = new RepositorioIndexedDB({
      nombreBd: 'test_idb_vacia',
      indexedDB: new IDBFactory(),
      puertoSync: new AdaptadorSupabaseDesacoplado(),
    });
    await repo.inicializar();

    // 1. Estado inicial estrictamente vacío
    const inicial = await repo.obtenerInstantanea();
    expect(inicial.vacia).toBe(true);
    expect(inicial.cuentas).toHaveLength(0);
    expect(inicial.movimientos).toHaveLength(0);

    // 2. Activar métodos iniciales (Efectivo, Yape, Plin, Débito, Crédito) -> todos sin saldos ficticios
    const metodos = await repo.activarMetodosInicialesSugeridos();
    expect(metodos.map((m) => m.nombre)).toEqual([
      'Efectivo',
      'Yape',
      'Plin',
      'Tarjeta de débito',
      'Tarjeta de crédito',
    ]);
    await repo.activarCategoriasInicialesSugeridas();

    const trasCatalogos = await repo.obtenerInstantanea();
    expect(trasCatalogos.movimientos).toHaveLength(0);

    const cuentaYape = trasCatalogos.cuentas.find((c) => c.nombre === 'Yape')!;
    const cuentaTC = trasCatalogos.cuentas.find((c) => c.nombre === 'Tarjeta de crédito')!;
    const catAlim = trasCatalogos.categorias.find((c) => c.nombre === 'Alimentación' && c.padreId === null)!;

    // 3. Registrar saldo inicial real para Yape (S/ 500.00 = 50000 céntimos)
    await repo.registrarOActualizarSaldoInicial({
      cuentaId: cuentaYape.id,
      saldoInicialCentimos: 50000,
      fechaSaldoInicial: '2026-11-01',
    });

    // 4. Crear un evento independiente y reutilizable y registrar un gasto con etiquetas libres
    const evento = await repo.crearEvento({
      nombre: 'Viaje familiar',
      fechaInicio: '2026-11-01',
      presupuestoCentimos: 120000,
    });

    const gasto = await repo.registrarMovimiento({
      fechaMovimiento: '2026-11-02',
      horaMovimiento: '09:30',
      tipo: 'GASTO',
      cuentaId: cuentaYape.id,
      categoriaId: catAlim.id,
      montoCentimos: 3500, // S/ 35.00
      etiquetas: ['#Rutina', '#ViajeTacna'],
      descripcion: 'Desayuno',
      eventoId: evento.id,
    });

    // 5. Editar el movimiento (cambia a S/ 40.00 = 4000 céntimos)
    const editado = await repo.editarMovimiento({
      id: gasto.id,
      montoCentimos: 4000,
      descripcion: 'Desayuno completo',
    });
    expect(editado.montoCentimos).toBe(4000);
    expect(editado.auditoria.version).toBe(2);

    // 6. Verificar que el saldo de Yape es 500.00 - 40.00 = 460.00 (46000 céntimos) y que TC no tiene saldo inicial
    const instConGasto = await repo.obtenerInstantanea();
    const resumen = calcularResumenPeriodo({
      periodoMes: '2026-11',
      cuentas: instConGasto.cuentas,
      categorias: instConGasto.categorias,
      movimientos: instConGasto.movimientos,
      presupuestos: instConGasto.presupuestos,
    });
    const saldoYape = resumen.saldosPorCuenta.find((s) => s.cuentaId === cuentaYape.id)!;
    const saldoTC = resumen.saldosPorCuenta.find((s) => s.cuentaId === cuentaTC.id)!;
    expect(saldoYape.saldoBancarioRealCentimos).toBe(46000);
    expect(saldoTC.saldoBancarioRealCentimos).toBeNull();

    // 7. Eliminación lógica y restauración
    await repo.eliminarMovimientoLogicamente(gasto.id);
    const trasEliminar = await repo.obtenerInstantanea();
    expect(trasEliminar.movimientos.filter((m) => m.estado === 'ACTIVO')).toHaveLength(1); // solo el saldo inicial

    await repo.restaurarMovimiento(gasto.id);
    const trasRestaurar = await repo.obtenerInstantanea();
    expect(trasRestaurar.movimientos.filter((m) => m.estado === 'ACTIVO')).toHaveLength(2);

    // 8. Verificar auditoría y cola de sincronización preparada para Supabase
    const auditoria = await repo.listarAuditoria();
    expect(auditoria.length).toBeGreaterThanOrEqual(5);
    const colaSync = await repo.listarCambiosPendientesSincronizacion();
    expect(colaSync.length).toBeGreaterThan(0);

    repo.cerrar();
  });

  it('ejecuta importaciones CSV de forma transaccional respetando las políticas OMITIR y SOBRESCRIBIR duplicados', async () => {
    const repo = new RepositorioIndexedDB({
      nombreBd: 'test_idb_import',
      indexedDB: new IDBFactory(),
    });
    await repo.inicializar();
    await repo.activarMetodosInicialesSugeridos();
    await repo.activarCategoriasInicialesSugeridas();

    const inst1 = await repo.obtenerInstantanea();
    const csv = [
      'fechaMovimiento,tipo,cuenta,categoria,montoPEN,etiquetas,descripcion',
      '2026-11-03,GASTO,Yape,Alimentación,22.00,#Rutina,Almuerzo de trabajo',
      '2026-11-04,GASTO,Efectivo,Transporte,15.00,#Rutina,Taxi',
    ].join('\n');

    const prev1 = previsualizarImportacionCsv({
      contenidoCsv: csv,
      cuentasExistentes: inst1.cuentas,
      categoriasExistentes: inst1.categorias,
      eventosExistentes: inst1.eventos,
      movimientosExistentes: inst1.movimientos,
      loteImportacionId: 'lote-a',
    });
    expect(prev1.validosNuevos).toBe(2);

    const res1 = await repo.ejecutarImportacionTransaccional({
      loteId: 'lote-a',
      filasPrevisualizadas: prev1.filas,
      politicaDuplicados: 'OMITIR',
    });
    expect(res1).toEqual({
      loteId: 'lote-a',
      insertados: 2,
      sobrescritos: 0,
      omitidosPorDuplicado: 0,
    });

    // Segunda importación del mismo CSV: detecta 2 duplicados
    const inst2 = await repo.obtenerInstantanea();
    const prev2 = previsualizarImportacionCsv({
      contenidoCsv: csv,
      cuentasExistentes: inst2.cuentas,
      categoriasExistentes: inst2.categorias,
      eventosExistentes: inst2.eventos,
      movimientosExistentes: inst2.movimientos,
      loteImportacionId: 'lote-b',
    });
    expect(prev2.duplicadosDetectados).toBe(2);

    // Con OMITIR no duplica transacciones
    const resOmitir = await repo.ejecutarImportacionTransaccional({
      loteId: 'lote-b',
      filasPrevisualizadas: prev2.filas,
      politicaDuplicados: 'OMITIR',
    });
    expect(resOmitir.omitidosPorDuplicado).toBe(2);
    expect((await repo.obtenerInstantanea()).movimientos).toHaveLength(2);

    // Con SOBRESCRIBIR actualiza sin duplicar el conteo total
    const resSobrescribir = await repo.ejecutarImportacionTransaccional({
      loteId: 'lote-c',
      filasPrevisualizadas: prev2.filas,
      politicaDuplicados: 'SOBRESCRIBIR',
    });
    expect(resSobrescribir.sobrescritos).toBe(2);
    expect((await repo.obtenerInstantanea()).movimientos).toHaveLength(2);

    repo.cerrar();
  });
});
