import { describe, expect, it } from 'vitest';
import {
  calcularResumenEvento,
  calcularSaldosYDeudasCompartidas,
  construirAgendaCalendario,
  construirCuotasEquitativas,
  construirCuotasPorPorcentaje,
  crearMovimientoNuevo,
  type EventoUniversal,
  type GastoCompartido,
  type GastoPlanificadoEvento,
  type LiquidacionCompartida,
  PLANTILLAS_PARTIDAS_VIAJE,
  proyectarOcurrenciasRegla,
  type ReglaRecurrencia,
} from '../src/index';

const auditoriaBase = {
  origen: 'MANUAL' as const,
  creadoEn: '2026-11-01T12:00:00.000Z',
  actualizadoEn: '2026-11-01T12:00:00.000Z',
  eliminadoEn: null,
  version: 1,
  loteImportacionId: null,
};

describe('Fase 2 — Gestión Universal de Eventos, Presupuestos, Control Diario (Burn Rate) y Planificación', () => {
  it('incluye las 5 categorías iniciales para viajes y soporta eventos de cualquier duración (sin límite de 7 días)', () => {
    expect(PLANTILLAS_PARTIDAS_VIAJE.map((p) => p.nombre)).toEqual([
      'Pasajes y transporte',
      'Alojamiento',
      'Alimentación',
      'Compras y frontera',
      'Imprevistos',
    ]);

    // Evento de 20 días (del 2026-11-01 al 2026-11-20), presupuesto S/ 2,000.00 (200000 céntimos)
    const evento20Dias: EventoUniversal = {
      id: 'ev-20d',
      nombre: 'Expedición Sur',
      tipoEvento: 'VIAJE',
      fechaInicio: '2026-11-01',
      fechaFin: '2026-11-20',
      ubicacion: 'Arequipa y Cusco',
      presupuestoTotalCentimos: 200000,
      moneda: 'PEN',
      partidasPresupuesto: [
        { id: 'p-transp', nombre: 'Pasajes y transporte', asignadoCentimos: 60000 },
        { id: 'p-aloj', nombre: 'Alojamiento', asignadoCentimos: 70000 },
        { id: 'p-alim', nombre: 'Alimentación', asignadoCentimos: 40000 },
        { id: 'p-comp', nombre: 'Compras y frontera', asignadoCentimos: 20000 },
        { id: 'p-impr', nombre: 'Imprevistos', asignadoCentimos: 10000 },
      ],
      participantes: [{ id: 'yo', nombre: 'Yo', esUsuarioTitular: true }],
      etiquetas: ['#ViajeLargo'],
      descripcion: 'Viaje de 20 días',
      estadoEvento: 'ACTIVO',
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    // 1. Antes de iniciar el evento (2026-10-25): 0 días transcurridos, 20 restantes, Burn Rate = 0, Recomendado = S/ 100.00/día
    const resAntes = calcularResumenEvento({
      evento: evento20Dias,
      movimientos: [],
      fechaReferenciaLima: '2026-10-25',
    });
    expect(resAntes.controlDiario.situacionTemporal).toBe('NO_INICIADO');
    expect(resAntes.controlDiario.diasTotalesEvento).toBe(20);
    expect(resAntes.controlDiario.diasTranscurridos).toBe(0);
    expect(resAntes.controlDiario.diasCalendarioRestantes).toBe(20);
    expect(resAntes.controlDiario.burnRateDiarioCentimos).toBe(0);
    expect(resAntes.controlDiario.presupuestoDiarioRecomendadoCentimos).toBe(10000); // S/ 100.00/día

    // 2. En el día 5 del evento (2026-11-05):
    //    - Gasto real acumulado = S/ 400.00 (40000 céntimos) -> Burn Rate = 40000 / 5 = 8000 (S/ 80.00/día)
    //    - Comprometido pendiente = S/ 100.00 (10000 céntimos)
    //    - Saldo disponible tras compromisos = 200000 - 40000 - 10000 = 150000 (S/ 1,500.00)
    //    - Días calendario restantes (del 05 al 20 inclusive) = 16 días
    //    - Presupuesto diario recomendado = 150000 / 16 = 9375 céntimos (S/ 93.75/día)
    //    - Como Burn Rate (8000) <= Recomendado (9375), evaluación = DENTRO_DE_RITMO
    const movRealAloj = crearMovimientoNuevo({
      id: 'tx-hotel',
      fechaMovimiento: '2026-11-02',
      tipo: 'GASTO',
      cuentaId: 'cta-1',
      categoriaId: 'cat-1',
      montoCentimos: 40000,
      eventoId: evento20Dias.id,
    });
    const itemComprometido: GastoPlanificadoEvento = {
      id: 'gp-1',
      eventoId: evento20Dias.id,
      partidaEventoId: 'p-transp',
      concepto: 'Boleto de retorno reservado',
      montoEstimadoCentimos: 10000,
      fechaPrevista: '2026-11-19',
      estadoPlanificacion: 'COMPROMETIDO',
      movimientoRealId: null,
      notas: null,
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };
    const itemYaRegistrado: GastoPlanificadoEvento = {
      id: 'gp-2',
      eventoId: evento20Dias.id,
      partidaEventoId: 'p-aloj',
      concepto: 'Pago hotel',
      montoEstimadoCentimos: 40000,
      fechaPrevista: '2026-11-02',
      estadoPlanificacion: 'REGISTRADO',
      movimientoRealId: movRealAloj.id,
      notas: null,
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    const resEnCurso = calcularResumenEvento({
      evento: evento20Dias,
      movimientos: [movRealAloj],
      gastosPlanificados: [itemComprometido, itemYaRegistrado],
      fechaReferenciaLima: '2026-11-05',
    });

    // Verifica que itemYaRegistrado NO se duplica en dineroComprometido ni en gastoReal
    expect(resEnCurso.gastoRealCentimos).toBe(40000);
    expect(resEnCurso.dineroComprometidoCentimos).toBe(10000);
    expect(resEnCurso.saldoDisponibleTrasCompromisosCentimos).toBe(150000);
    expect(resEnCurso.porcentajeConsumidoBp).toBe(2000); // 20.00%
    expect(resEnCurso.controlDiario.diasTranscurridos).toBe(5);
    expect(resEnCurso.controlDiario.diasCalendarioRestantes).toBe(16);
    expect(resEnCurso.controlDiario.burnRateDiarioCentimos).toBe(8000);
    expect(resEnCurso.controlDiario.presupuestoDiarioRecomendadoCentimos).toBe(9375);
    expect(resEnCurso.controlDiario.evaluacionRitmo).toBe('DENTRO_DE_RITMO');

    // 3. Evento finalizado (después de fechaFin): días restantes = 0
    const resFinalizado = calcularResumenEvento({
      evento: evento20Dias,
      movimientos: [movRealAloj],
      gastosPlanificados: [itemYaRegistrado],
      fechaReferenciaLima: '2026-11-25',
    });
    expect(resFinalizado.controlDiario.situacionTemporal).toBe('FINALIZADO');
    expect(resFinalizado.controlDiario.diasCalendarioRestantes).toBe(0);
    expect(resFinalizado.controlDiario.burnRateDiarioCentimos).toBe(2000); // 40000 / 20 días
  });
});

describe('Fase 2 — Gastos Compartidos, Divisiones, Pagos Parciales y Liquidaciones', () => {
  const participantes = [
    { id: 'yo', nombre: 'Yo', esUsuarioTitular: true },
    { id: 'ana', nombre: 'Ana', esUsuarioTitular: false },
    { id: 'luis', nombre: 'Luis', esUsuarioTitular: false },
  ];

  it('diferencia lo que salió de mi bolsillo, mi cuota real, lo que me deben y lo que debo, soportando pagos parciales', () => {
    // Gasto 1: Yo pago S/ 300.00 (30000 céntimos) dividido equitativamente entre los 3 (S/ 100.00 c/u)
    const gasto1: GastoCompartido = {
      id: 'gc-1',
      eventoId: 'ev-1',
      descripcion: 'Alojamiento compartido',
      fechaGasto: '2026-11-02',
      importeTotalCentimos: 30000,
      pagadoPorParticipanteId: 'yo',
      movimientoRealId: 'tx-1',
      cuotas: construirCuotasEquitativas(30000, ['yo', 'ana', 'luis']),
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    // Gasto 2: Ana paga S/ 120.00 (12000 céntimos) dividido 50% Yo (S/ 60), 25% Ana (S/ 30), 25% Luis (S/ 30)
    const gasto2: GastoCompartido = {
      id: 'gc-2',
      eventoId: 'ev-1',
      descripcion: 'Cena especial',
      fechaGasto: '2026-11-03',
      importeTotalCentimos: 12000,
      pagadoPorParticipanteId: 'ana',
      movimientoRealId: null,
      cuotas: construirCuotasPorPorcentaje(12000, [
        { participanteId: 'yo', porcentajeBp: 5000 },
        { participanteId: 'ana', porcentajeBp: 2500 },
        { participanteId: 'luis', porcentajeBp: 2500 },
      ]),
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    // Antes de liquidaciones:
    // - Dinero que salió de mi bolsillo = S/ 300.00 (30000)
    // - Parte del gasto que realmente me corresponde = S/ 100.00 + S/ 60.00 = S/ 160.00 (16000)
    // - Mi saldo neto a favor = 300.00 - 160.00 = +S/ 140.00 (14000 me deben en neto)
    // - Saldo de Ana: pagó 120.00, le corresponde 100 + 30 = 130.00 -> debe S/ 10.00 (-1000)
    // - Saldo de Luis: pagó 0, le corresponde 100 + 30 = 130.00 -> debe S/ 130.00 (-13000)
    const antesLiq = calcularSaldosYDeudasCompartidas({
      participantes,
      gastosCompartidos: [gasto1, gasto2],
      liquidaciones: [],
    });

    expect(antesLiq.perspectivaUsuario).toEqual({
      dineroSalioDeMiBolsilloCentimos: 30000,
      reembolsosRecibidosCentimos: 0,
      parteGastoQueMeCorrespondeCentimos: 16000,
      dineroQueMeDebenCentimos: 14000,
      dineroQueDeboCentimos: 0,
    });
    expect(antesLiq.quienDebeAQuien).toEqual([
      {
        deudorId: 'luis',
        nombreDeudor: 'Luis',
        acreedorId: 'yo',
        nombreAcreedor: 'Yo',
        montoPendienteCentimos: 13000,
      },
      {
        deudorId: 'ana',
        nombreDeudor: 'Ana',
        acreedorId: 'yo',
        nombreAcreedor: 'Yo',
        montoPendienteCentimos: 1000,
      },
    ]);

    // Luis realiza un pago parcial de S/ 80.00 (8000 céntimos) a Yo:
    const pagoParcialLuis: LiquidacionCompartida = {
      id: 'liq-1',
      eventoId: 'ev-1',
      gastoCompartidoId: null,
      fechaLiquidacion: '2026-11-04',
      deudorParticipanteId: 'luis',
      acreedorParticipanteId: 'yo',
      montoCentimos: 8000,
      movimientoRealId: null,
      nota: 'Adelanto por Yape',
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    const trasPagoParcial = calcularSaldosYDeudasCompartidas({
      participantes,
      gastosCompartidos: [gasto1, gasto2],
      liquidaciones: [pagoParcialLuis],
    });

    // Ahora Luis solo me debe S/ 50.00 (5000) y Ana S/ 10.00 (1000) -> total que me deben = S/ 60.00 (6000)
    expect(trasPagoParcial.perspectivaUsuario.reembolsosRecibidosCentimos).toBe(8000);
    expect(trasPagoParcial.perspectivaUsuario.dineroQueMeDebenCentimos).toBe(6000);
  });
});

describe('Fase 2 — Reglas de Recurrencia (previsiones) y Calendario Financiero', () => {
  it('proyecta ocurrencias semanales, mensuales, anuales y personalizadas sin registrar gastos reales automáticamente', () => {
    const reglaMensual: ReglaRecurrencia = {
      id: 'rec-alquiler',
      nombre: 'Alquiler departamento',
      tipo: 'GASTO',
      montoEstimadoCentimos: 150000,
      cuentaId: 'cta-1',
      categoriaId: 'cat-vivienda',
      subcategoriaId: null,
      eventoId: null,
      frecuencia: 'MENSUAL',
      intervaloDias: null,
      fechaInicio: '2026-01-31',
      fechaFin: null,
      etiquetas: ['#Hogar'],
      fechasMaterializadas: { '2026-01-31': 'tx-enero' },
      fechasOmitidas: [],
      activa: true,
      estado: 'ACTIVO',
      auditoria: auditoriaBase,
    };

    // Proyectar primer trimestre 2026 (verifica ajuste de fin de mes en febrero: 2026-02-28)
    const ocs = proyectarOcurrenciasRegla(reglaMensual, '2026-01-01', '2026-03-31');
    expect(ocs.map((o) => o.fechaProgramada)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(ocs[0]!.origen).toBe('PROYECTADO');
    expect(ocs[0]!.estadoOcurrencia).toBe('AUTORIZADA_REGISTRADA');
    expect(ocs[1]!.estadoOcurrencia).toBe('PENDIENTE_AUTORIZACION');
    expect(ocs[1]!.movimientoRealId).toBeNull();

    const agenda = construirAgendaCalendario({
      desde: '2026-02-01',
      hasta: '2026-02-28',
      eventos: [],
      gastosPlanificados: [],
      reglasRecurrencia: [reglaMensual],
    });
    expect(agenda).toHaveLength(1);
    expect(agenda[0]!.tipoHito).toBe('FECHA_PAGO_RECURRENTE');
    expect(agenda[0]!.origen).toBe('PROYECTADO');
  });
});
