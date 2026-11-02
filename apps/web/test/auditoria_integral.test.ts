/**
 * Suite de Verificación de Auditoría Integral (Contabilidad, Base de Datos,
 * Respaldos de 9 Entidades, Conciliación Analítica y Sincronización Cloud).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  AlmacenNubeConRls,
  calcularCurvaLiquidezYDesviacion,
  calcularSaldosPorCuenta,
  exportarJsonCifradoConContrasena,
  exportarLibroAJson,
  filtrarMovimientosAnalitica,
  importarJsonCifradoConContrasena,
  previsualizarImportacionJson,
} from '@mis-cuentas/core';
import { ClienteSupabasePrivado } from '../src/persistencia/cliente_supabase';
import { RepositorioIndexedDB } from '../src/persistencia/indexeddb';

describe('Auditoría Integral — Verificación de Correcciones Críticas y Altas', () => {
  it('1. Sincroniza SALDO_INICIAL en S/ 0.00 y deuda inicial negativa en TARJETA_CREDITO sin alterar monto_centimos', async () => {
    const repo = new RepositorioIndexedDB({ nombreBd: `test-audit-saldos-${Date.now()}` });
    await repo.inicializar();

    const cuentaAhorro = await repo.crearCuenta({
      nombre: 'Cuenta Sueldo',
      tipo: 'CUENTA_BANCARIA',
      saldoInicialCentimos: 0,
      fechaSaldoInicial: '2026-10-01',
    });
    const tarjetaCredito = await repo.crearCuenta({
      nombre: 'Tarjeta Visa',
      tipo: 'TARJETA_CREDITO',
      saldoInicialCentimos: -45000, // Deuda inicial de -S/ 450.00
      fechaSaldoInicial: '2026-10-01',
    });

    const inst = await repo.obtenerInstantanea();
    const saldos = calcularSaldosPorCuenta(inst.cuentas, inst.movimientos);
    const sAhorro = saldos.find((s) => s.cuentaId === cuentaAhorro.id)!;
    const sTarjeta = saldos.find((s) => s.cuentaId === tarjetaCredito.id)!;

    expect(sAhorro.estadoSaldo).toBe('SALDO_REAL_COMPLETO');
    expect(sAhorro.saldoBancarioRealCentimos).toBe(0);
    expect(sTarjeta.estadoSaldo).toBe('SALDO_REAL_COMPLETO');
    expect(sTarjeta.saldoBancarioRealCentimos).toBe(-45000);

    // Verificar serialización exacta hacia Supabase REST en ClienteSupabasePrivado
    const cuerposEnviados: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const metodo = init?.method ?? 'GET';
      if (metodo === 'GET' && url.includes('/rest/v1/')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (metodo === 'POST' && url.includes('/rest/v1/transacciones_sync')) {
        cuerposEnviados.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(init?.body ?? '{}', { status: 201 });
      }
      if (metodo === 'POST' && url.includes('/rest/v1/')) {
        return new Response(init?.body ?? '{}', { status: 201 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const cliente = new ClienteSupabasePrivado({
        url: 'https://proyecto-auditoria.supabase.co',
        publishableKey: 'sb_publishable_auditoria_key_12345',
      });
      cliente.restaurarSesion({
        uid: 'uid-audit-1',
        email: 'audit@miscuentas.pe',
        accessToken: 'jwt-audit-1',
        expiraEnEpochSegundos: Math.floor(Date.now() / 1000) + 3600,
      });

      await repo.sincronizarConTransporte({
        transporte: cliente,
        propietarioId: 'uid-audit-1',
        dispositivoId: 'celular-audit',
      });

      expect(cuerposEnviados).toHaveLength(2);
      const montosEnviados = cuerposEnviados.map((c) => c.monto_centimos).sort((a, b) => Number(a) - Number(b));
      expect(montosEnviados).toEqual([-45000, 0]);
    } finally {
      vi.unstubAllGlobals();
      repo.cerrar();
    }
  });

  it('2. Impide eliminaciones lógicas que rompan la integridad referencial y elimina en cascada el movimiento vinculado a un gasto compartido', async () => {
    const repo = new RepositorioIndexedDB({ nombreBd: `test-audit-fk-${Date.now()}` });
    await repo.inicializar();

    const cuenta = await repo.crearCuenta({
      nombre: 'Yape Principal',
      tipo: 'YAPE',
      saldoInicialCentimos: 100000,
      fechaSaldoInicial: '2026-10-01',
    });
    const catPadre = await repo.crearCategoria({
      nombre: 'Alimentación',
      naturaleza: 'GASTO',
    });
    const subCat = await repo.crearCategoria({
      nombre: 'Restaurantes',
      naturaleza: 'GASTO',
      padreId: catPadre.id,
    });
    const evento = await repo.crearEvento({
      nombre: 'Viaje Cusco',
      tipoEvento: 'VIAJE',
      fechaInicio: '2026-10-01',
      fechaFin: '2026-10-10',
      presupuestoTotalCentimos: 200000,
      participantes: [
        { id: 'yo', nombre: 'Yo', esUsuarioTitular: true },
        { id: 'amigo', nombre: 'Luis', esUsuarioTitular: false },
      ],
    });

    // No permite eliminar categoría padre mientras tenga subcategoría activa
    await expect(repo.eliminarCategoriaLogicamente(catPadre.id)).rejects.toThrow(/subcategorías activas/i);

    // Registrar gasto compartido con impacto en mi cuenta y vinculado al evento
    const compartido = await repo.registrarGastoCompartido({
      eventoId: evento.id,
      descripcion: 'Cena compartida en Cusco',
      fechaGasto: '2026-10-03',
      importeTotalCentimos: 12000,
      pagadoPorParticipanteId: 'yo',
      cuotas: [
        {
          participanteId: 'yo',
          importeCorrespondienteCentimos: 6000,
          porcentajeBp: 5000,
          aporteDirectoEnCompraCentimos: 0,
        },
        {
          participanteId: 'amigo',
          importeCorrespondienteCentimos: 6000,
          porcentajeBp: 5000,
          aporteDirectoEnCompraCentimos: 0,
        },
      ],
      registroEnMiCuenta: {
        cuentaId: cuenta.id,
        categoriaId: catPadre.id,
        subcategoriaId: subCat.id,
      },
    });
    expect(compartido.movimientoRealId).toBeTruthy();

    // No permite eliminar cuenta, subcategoría ni evento mientras tengan registros activos vinculados
    await expect(repo.eliminarCuentaLogicamente(cuenta.id)).rejects.toThrow(/movimientos activos/i);
    await expect(repo.eliminarCategoriaLogicamente(subCat.id)).rejects.toThrow(/movimientos activos/i);
    await expect(repo.eliminarEventoLogicamente(evento.id)).rejects.toThrow(/movimientos activos/i);

    // Al eliminar lógicamente el gasto compartido, el movimiento real vinculado también pasa a ELIMINADO
    await repo.eliminarGastoCompartidoLogicamente(compartido.id);

    const instTrasEliminarCompartido = await repo.obtenerInstantanea();
    const movVinculado = instTrasEliminarCompartido.movimientos.find(
      (m) => m.id === compartido.movimientoRealId,
    );
    expect(movVinculado?.estado).toBe('ELIMINADO');

    // Ahora que no quedan movimientos ni gastos compartidos activos, se pueden eliminar evento, subcategoría y categoría
    await repo.eliminarEventoLogicamente(evento.id);
    await repo.eliminarCategoriaLogicamente(subCat.id);
    await repo.eliminarCategoriaLogicamente(catPadre.id);

    const instFinal = await repo.obtenerInstantanea();
    expect(instFinal.eventos.filter((e) => e.estado === 'ACTIVO')).toHaveLength(0);
    expect(instFinal.categorias.filter((c) => c.estado === 'ACTIVO')).toHaveLength(0);

    repo.cerrar();
  });

  it('3. Exporta, cifra (AES-256-GCM), restaura las 9 colecciones del dominio y las encola en COLA_SYNC para sincronizar con la nube', async () => {
    const repoOrigen = new RepositorioIndexedDB({ nombreBd: `test-audit-backup-orig-${Date.now()}` });
    await repoOrigen.inicializar();

    const cuenta = await repoOrigen.crearCuenta({
      nombre: 'BCP Soles',
      tipo: 'CUENTA_BANCARIA',
      saldoInicialCentimos: 250000,
      fechaSaldoInicial: '2026-10-01',
    });
    const catGasto = await repoOrigen.crearCategoria({
      nombre: 'Servicios',
      naturaleza: 'GASTO',
    });
    const evento = await repoOrigen.crearEvento({
      nombre: 'Proyecto Estudio',
      tipoEvento: 'PROYECTO',
      fechaInicio: '2026-10-01',
      fechaFin: '2026-10-30',
      presupuestoTotalCentimos: 150000,
      participantes: [
        { id: 'yo', nombre: 'Yo', esUsuarioTitular: true },
        { id: 'socio', nombre: 'Ana', esUsuarioTitular: false },
      ],
    });
    await repoOrigen.guardarPresupuesto({
      periodoMes: '2026-10',
      categoriaId: catGasto.id,
      limiteCentimos: 80000,
    });
    await repoOrigen.registrarMovimiento({
      fechaMovimiento: '2026-10-05',
      horaMovimiento: '10:30',
      tipo: 'GASTO',
      cuentaId: cuenta.id,
      categoriaId: catGasto.id,
      montoCentimos: 15000,
      descripcion: 'Fibra óptica',
    });
    await repoOrigen.crearGastoPlanificado({
      eventoId: evento.id,
      concepto: 'Monitor 27 pulgadas',
      montoEstimadoCentimos: 95000,
      fechaPrevista: '2026-10-20',
      estadoPlanificacion: 'COMPROMETIDO',
    });
    const gc = await repoOrigen.registrarGastoCompartido({
      eventoId: evento.id,
      descripcion: 'Licencia software anual',
      fechaGasto: '2026-10-06',
      importeTotalCentimos: 40000,
      pagadoPorParticipanteId: 'yo',
      cuotas: [
        {
          participanteId: 'yo',
          importeCorrespondienteCentimos: 20000,
          porcentajeBp: 5000,
          aporteDirectoEnCompraCentimos: 0,
        },
        {
          participanteId: 'socio',
          importeCorrespondienteCentimos: 20000,
          porcentajeBp: 5000,
          aporteDirectoEnCompraCentimos: 0,
        },
      ],
    });
    await repoOrigen.registrarLiquidacionCompartida({
      eventoId: evento.id,
      gastoCompartidoId: gc.id,
      fechaLiquidacion: '2026-10-07',
      deudorParticipanteId: 'socio',
      acreedorParticipanteId: 'yo',
      montoCentimos: 20000,
      nota: 'Reembolso Yape Ana',
    });
    await repoOrigen.crearReglaRecurrencia({
      nombre: 'Internet Mensual',
      tipo: 'GASTO',
      montoEstimadoCentimos: 15000,
      cuentaId: cuenta.id,
      categoriaId: catGasto.id,
      frecuencia: 'MENSUAL',
      fechaInicio: '2026-10-05',
    });

    const instOrigen = await repoOrigen.obtenerInstantanea();
    const jsonPlano = exportarLibroAJson({
      cuentas: instOrigen.cuentas,
      categorias: instOrigen.categorias,
      eventos: instOrigen.eventos,
      presupuestos: instOrigen.presupuestos,
      movimientos: instOrigen.movimientos,
      gastosPlanificados: instOrigen.gastosPlanificados,
      gastosCompartidos: instOrigen.gastosCompartidos,
      liquidacionesCompartidas: instOrigen.liquidacionesCompartidas,
      reglasRecurrencia: instOrigen.reglasRecurrencia,
    });

    const jsonCifrado = await exportarJsonCifradoConContrasena(
      JSON.parse(jsonPlano),
      'ClaveAuditoria#2026',
    );
    const descifrado = await importarJsonCifradoConContrasena(
      jsonCifrado,
      'ClaveAuditoria#2026',
    );

    // Restaurar en un dispositivo completamente limpio
    const repoDestino = new RepositorioIndexedDB({ nombreBd: `test-audit-backup-dest-${Date.now()}` });
    await repoDestino.inicializar();

    const prev = previsualizarImportacionJson({
      contenidoJson: JSON.stringify(descifrado),
      movimientosExistentes: [],
      loteImportacionId: 'lote-audit-9-colecciones',
    });
    expect(prev.conErrores).toBe(0);

    await repoDestino.ejecutarImportacionTransaccional({
      loteId: 'lote-audit-9-colecciones',
      filasPrevisualizadas: prev.filas,
      politicaDuplicados: 'OMITIR',
      cuentasIncluidas: prev.cuentasIncluidas,
      categoriasIncluidas: prev.categoriasIncluidas,
      eventosIncluidos: prev.eventosIncluidos,
      presupuestosIncluidos: prev.presupuestosIncluidos,
      gastosPlanificadosIncluidos: prev.gastosPlanificadosIncluidos,
      gastosCompartidosIncluidos: prev.gastosCompartidosIncluidos,
      liquidacionesCompartidasIncluidas: prev.liquidacionesCompartidasIncluidas,
      reglasRecurrenciaIncluidas: prev.reglasRecurrenciaIncluidas,
    });

    const instDestino = await repoDestino.obtenerInstantanea();
    expect(instDestino.cuentas).toHaveLength(1);
    expect(instDestino.categorias).toHaveLength(1);
    expect(instDestino.eventos).toHaveLength(1);
    expect(instDestino.presupuestos).toHaveLength(1);
    expect(instDestino.movimientos).toHaveLength(2); // SALDO_INICIAL + GASTO
    expect(instDestino.gastosPlanificados).toHaveLength(1);
    expect(instDestino.gastosCompartidos).toHaveLength(1);
    expect(instDestino.liquidacionesCompartidas).toHaveLength(1);
    expect(instDestino.reglasRecurrencia).toHaveLength(1);

    // Verificar que las 9 colecciones restauradas quedaron encoladas en COLA_SYNC y se suben a la nube
    const nube = new AlmacenNubeConRls({ uidPropietarioAutorizado: 'uid-audit-prop' });
    const syncRes = await repoDestino.sincronizarConTransporte({
      transporte: nube,
      propietarioId: 'uid-audit-prop',
      dispositivoId: 'celular-restaurado',
    });
    expect(syncRes.enviados).toBe(10); // 1 cuenta + 1 cat + 1 ev + 1 pres + 2 movs + 1 plan + 1 comp + 1 liq + 1 rec

    repoOrigen.cerrar();
    repoDestino.cerrar();
  });

  it('4. Concilia al 100% el saldoBancarioRealCierreCentimos de la Curva de Liquidez con calcularSaldosPorCuenta incluso tras filtrar el mes y con transferencias', async () => {
    const repo = new RepositorioIndexedDB({ nombreBd: `test-audit-liquidez-${Date.now()}` });
    await repo.inicializar();

    const cuentaBanco = await repo.crearCuenta({
      nombre: 'Banco Nación',
      tipo: 'CUENTA_BANCARIA',
      saldoInicialCentimos: 300000, // S/ 3,000.00 el 2026-09-01
      fechaSaldoInicial: '2026-09-01',
    });
    const cuentaEfectivo = await repo.crearCuenta({
      nombre: 'Efectivo',
      tipo: 'EFECTIVO',
      saldoInicialCentimos: 20000, // S/ 200.00 el 2026-09-01
      fechaSaldoInicial: '2026-09-01',
    });
    const catIngreso = await repo.crearCategoria({
      nombre: 'Sueldo',
      naturaleza: 'INGRESO',
    });
    const catGasto = await repo.crearCategoria({
      nombre: 'Alimentación',
      naturaleza: 'GASTO',
    });

    // Movimiento en septiembre (mes previo al filtro de octubre)
    await repo.registrarMovimiento({
      fechaMovimiento: '2026-09-15',
      horaMovimiento: '14:00',
      tipo: 'GASTO',
      cuentaId: cuentaBanco.id,
      categoriaId: catGasto.id,
      montoCentimos: 50000, // -S/ 500.00 en septiembre (Banco queda en S/ 2,500.00 al cierre de sep)
    });

    // Movimientos en octubre
    await repo.registrarMovimiento({
      fechaMovimiento: '2026-10-02',
      horaMovimiento: '09:00',
      tipo: 'INGRESO',
      cuentaId: cuentaBanco.id,
      categoriaId: catIngreso.id,
      montoCentimos: 100000, // +S/ 1,000.00
    });
    await repo.registrarMovimiento({
      fechaMovimiento: '2026-10-05',
      horaMovimiento: '11:00',
      tipo: 'TRANSFERENCIA',
      cuentaId: cuentaBanco.id,
      cuentaDestinoId: cuentaEfectivo.id,
      montoCentimos: 30000, // Retiro de cajero: -S/ 300.00 en Banco, +S/ 300.00 en Efectivo
    });
    await repo.registrarMovimiento({
      fechaMovimiento: '2026-10-08',
      horaMovimiento: '19:00',
      tipo: 'GASTO',
      cuentaId: cuentaBanco.id,
      categoriaId: catGasto.id,
      montoCentimos: 20000, // -S/ 200.00 en Banco
    });

    const inst = await repo.obtenerInstantanea();
    const saldosReales = calcularSaldosPorCuenta(inst.cuentas, inst.movimientos);
    const saldoBancoReal = saldosReales.find((s) => s.cuentaId === cuentaBanco.id)!;
    // 3,000 - 500 (sep) + 1,000 (oct) - 300 (transf) - 200 (gasto oct) = S/ 3,000.00 (300,000 céntimos)
    expect(saldoBancoReal.saldoBancarioRealCentimos).toBe(300000);

    // Filtrar Analítica Avanzada para Octubre y Cuenta Banco Nación (como hace PanelAnaliticaAvanzada)
    const filtradosOctubreBanco = filtrarMovimientosAnalitica(inst.movimientos, {
      modoPeriodo: 'MES',
      mes: '2026-10',
      cuentaId: cuentaBanco.id,
    });

    const curva = calcularCurvaLiquidezYDesviacion({
      movimientos: filtradosOctubreBanco,
      movimientosCompletos: inst.movimientos,
      cuentas: inst.cuentas,
      cuentaFiltradaId: cuentaBanco.id,
    });

    expect(curva.estado).toBe('OK');
    if (curva.estado === 'OK') {
      expect(curva.datos.tieneSaldoBancarioRealCompleto).toBe(true);
      const ultimoPunto =
        curva.datos.puntosDiarios[curva.datos.puntosDiarios.length - 1]!;
      // Conciliación exacta: el saldo bancario al cierre de la curva coincide al céntimo con calcularSaldosPorCuenta
      expect(ultimoPunto.saldoBancarioRealCierreCentimos).toBe(
        saldoBancoReal.saldoBancarioRealCentimos,
      );
    }

    repo.cerrar();
  });
});
