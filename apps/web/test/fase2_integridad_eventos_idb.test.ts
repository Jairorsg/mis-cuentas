import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  calcularResumenEvento,
  calcularResumenPeriodo,
  calcularSaldosYDeudasCompartidas,
  construirCuotasEquitativas,
} from '@mis-cuentas/core';
import { RepositorioIndexedDB } from '../src/persistencia/indexeddb';

describe('Fase 2 en IndexedDB: integridad financiera entre Eventos, Planificación, Compartidos, Recurrencia y Libro Único', () => {
  it('actualiza el control diario al registrar/editar/eliminar transacciones, convierte gastos planificados sin duplicar y mantiene integridad de saldos', async () => {
    const repo = new RepositorioIndexedDB({
      nombreBd: 'test_fase2_integridad',
      indexedDB: new IDBFactory(),
    });
    await repo.inicializar();
    await repo.activarMetodosInicialesSugeridos();
    await repo.activarCategoriasInicialesSugeridas();

    const inst0 = await repo.obtenerInstantanea();
    expect(inst0.versionEsquema).toBe(2);
    const cuentaYape = inst0.cuentas.find((c) => c.nombre === 'Yape')!;
    const catTransporte = inst0.categorias.find((c) => c.nombre === 'Transporte' && c.padreId === null)!;
    const catAlim = inst0.categorias.find((c) => c.nombre === 'Alimentación' && c.padreId === null)!;

    // 1. Registrar saldo inicial real en Yape: S/ 1,000.00 (100000 céntimos)
    await repo.registrarOActualizarSaldoInicial({
      cuentaId: cuentaYape.id,
      saldoInicialCentimos: 100000,
      fechaSaldoInicial: '2026-11-01',
    });

    // 2. Crear un evento tipo VIAJE de 10 días (2026-11-01 al 2026-11-10) con presupuesto S/ 800.00 (80000 céntimos)
    const evento = await repo.crearEvento({
      nombre: 'Ruta Costera',
      tipoEvento: 'VIAJE',
      fechaInicio: '2026-11-01',
      fechaFin: '2026-11-10',
      presupuestoTotalCentimos: 80000,
      participantes: [
        { id: 'yo', nombre: 'Yo', esUsuarioTitular: true },
        { id: 'marco', nombre: 'Marco', esUsuarioTitular: false },
      ],
      incluirPlantillaViaje: true,
    });
    expect(evento.partidasPresupuesto).toHaveLength(5);

    // 3. Añadir un gasto comprometido de S/ 120.00 (12000 céntimos) para pasajes
    const partidaPasajes = evento.partidasPresupuesto.find((p) => p.nombre === 'Pasajes y transporte')!;
    const planPasaje = await repo.crearGastoPlanificado({
      eventoId: evento.id,
      partidaEventoId: partidaPasajes.id,
      concepto: 'Pasaje interprovincial',
      montoEstimadoCentimos: 12000,
      fechaPrevista: '2026-11-01',
      estadoPlanificacion: 'COMPROMETIDO',
    });

    // Verificar que antes de convertirlo a real figura como dinero comprometido (12000) y gasto real (0)
    const instAntesConvertir = await repo.obtenerInstantanea();
    const resAntes = calcularResumenEvento({
      evento,
      movimientos: instAntesConvertir.movimientos,
      gastosPlanificados: instAntesConvertir.gastosPlanificados,
      fechaReferenciaLima: '2026-11-02',
    });
    expect(resAntes.gastoRealCentimos).toBe(0);
    expect(resAntes.dineroComprometidoCentimos).toBe(12000);
    expect(resAntes.saldoDisponibleTrasCompromisosCentimos).toBe(68000);

    // 4. Convertir el gasto comprometido en transacción real -> NO debe duplicarse
    const { movimientoReal } = await repo.convertirGastoPlanificadoEnMovimientoReal({
      gastoPlanificadoId: planPasaje.id,
      cuentaId: cuentaYape.id,
      categoriaId: catTransporte.id,
    });

    // Intentar convertirlo una segunda vez debe fallar para impedir doble conteo
    await expect(
      repo.convertirGastoPlanificadoEnMovimientoReal({
        gastoPlanificadoId: planPasaje.id,
        cuentaId: cuentaYape.id,
        categoriaId: catTransporte.id,
      }),
    ).rejects.toThrow(/ya fue convertido/);

    const instTrasConvertir = await repo.obtenerInstantanea();
    const resTrasConvertir = calcularResumenEvento({
      evento,
      movimientos: instTrasConvertir.movimientos,
      gastosPlanificados: instTrasConvertir.gastosPlanificados,
      fechaReferenciaLima: '2026-11-02',
    });
    expect(resTrasConvertir.gastoRealCentimos).toBe(12000);
    expect(resTrasConvertir.dineroComprometidoCentimos).toBe(0);
    expect(resTrasConvertir.saldoDisponibleTrasCompromisosCentimos).toBe(68000);
    expect(resTrasConvertir.controlDiario.burnRateDiarioCentimos).toBe(6000); // 12000 / 2 días transcurridos

    // 5. Editar la transacción real a S/ 140.00 (14000) -> recalcula automáticamente Burn Rate y saldo disponible
    await repo.editarMovimiento({
      id: movimientoReal.id,
      montoCentimos: 14000,
    });
    const instTrasEditar = await repo.obtenerInstantanea();
    const resTrasEditar = calcularResumenEvento({
      evento,
      movimientos: instTrasEditar.movimientos,
      gastosPlanificados: instTrasEditar.gastosPlanificados,
      fechaReferenciaLima: '2026-11-02',
    });
    expect(resTrasEditar.gastoRealCentimos).toBe(14000);
    expect(resTrasEditar.controlDiario.burnRateDiarioCentimos).toBe(7000); // 14000 / 2 días

    // 6. Registrar un gasto compartido donde Yo pago S/ 60.00 (6000 céntimos) de almuerzo entre Yo y Marco (S/ 30 c/u)
    await repo.registrarGastoCompartido({
      eventoId: evento.id,
      descripcion: 'Almuerzo para dos',
      fechaGasto: '2026-11-02',
      importeTotalCentimos: 6000,
      pagadoPorParticipanteId: 'yo',
      cuotas: construirCuotasEquitativas(6000, ['yo', 'marco']),
      registroEnMiCuenta: {
        cuentaId: cuentaYape.id,
        categoriaId: catAlim.id,
      },
    });

    // Verificar que la deuda por cobrar de Marco (S/ 30.00) NO se contabilizó como ingreso real en el Dashboard
    const instConCompartido = await repo.obtenerInstantanea();
    const dashboard = calcularResumenPeriodo({
      periodoMes: '2026-11',
      cuentas: instConCompartido.cuentas,
      categorias: instConCompartido.categorias,
      movimientos: instConCompartido.movimientos,
      presupuestos: instConCompartido.presupuestos,
    });
    expect(dashboard.ingresosPeriodoCentimos).toBe(0);
    expect(dashboard.egresosPeriodoCentimos).toBe(20000); // 14000 pasaje + 6000 almuerzo desembolsado
    expect(dashboard.saldoRegistradoConocidoCentimos).toBe(80000); // 100000 inicial - 20000

    const saldosComp = calcularSaldosYDeudasCompartidas({
      participantes: evento.participantes,
      gastosCompartidos: instConCompartido.gastosCompartidos,
      liquidaciones: instConCompartido.liquidacionesCompartidas,
    });
    expect(saldosComp.perspectivaUsuario.dineroSalioDeMiBolsilloCentimos).toBe(6000);
    expect(saldosComp.perspectivaUsuario.parteGastoQueMeCorrespondeCentimos).toBe(3000);
    expect(saldosComp.perspectivaUsuario.dineroQueMeDebenCentimos).toBe(3000);

    // 7. Crear una regla recurrente y verificar que NO crea movimientos reales hasta autorizarla
    const regla = await repo.crearReglaRecurrencia({
      nombre: 'Suscripción nube',
      tipo: 'GASTO',
      montoEstimadoCentimos: 2500,
      frecuencia: 'MENSUAL',
      fechaInicio: '2026-11-05',
      cuentaId: cuentaYape.id,
      categoriaId: catTransporte.id,
    });
    const antesAutorizar = await repo.obtenerInstantanea();
    expect(antesAutorizar.movimientos.filter((m) => m.estado === 'ACTIVO')).toHaveLength(3); // saldo inicial + pasaje + almuerzo

    await repo.autorizarOcurrenciaRecurrente({
      reglaId: regla.id,
      fechaProgramada: '2026-11-05',
    });
    const trasAutorizar = await repo.obtenerInstantanea();
    expect(trasAutorizar.movimientos.filter((m) => m.estado === 'ACTIVO')).toHaveLength(4);

    repo.cerrar();
  });
});
