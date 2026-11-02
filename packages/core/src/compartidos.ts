/**
 * Módulo 5 de Fase 2: Gastos Compartidos, Participantes, Pagos Parciales y Liquidaciones.
 *
 * REGLAS CONTABLES ESTRICTAS:
 *  1. Diferencia explícitamente:
 *     - Dinero que salió de mi bolsillo (`dineroSalioDeMiBolsilloCentimos`).
 *     - Parte del gasto que realmente me corresponde (`parteGastoQueMeCorrespondeCentimos`).
 *     - Dinero que otras personas me deben (`dineroQueMeDebenCentimos` — cuenta por cobrar).
 *     - Dinero que debo a otras personas (`dineroQueDeboCentimos` — cuenta por pagar).
 *  2. Evita contabilizar las deudas por cobrar como ingresos reales antes de recibir el dinero.
 *  3. Soporta división equitativa, por porcentaje (basis points) o por montos exactos.
 *  4. Soporta pagos parciales y liquidaciones completas entre participantes, recalculando
 *     automáticamente quién debe a quién.
 */
import { assertMontoEntero, type MontoMinor, repartirEquitativo, repartirProporcional, sumarMontos } from './dinero';
import { esFechaContableValida } from './fechas';
import type { ParticipanteEvento } from './eventos';
import type { EstadoRegistro, MetadatosAuditoria } from './libro';

export interface CuotaParticipanteGasto {
  participanteId: string;
  /** Importe exacto en céntimos que le corresponde asumir a este participante en el gasto. */
  importeCorrespondienteCentimos: MontoMinor;
  /** Porcentaje referencial en basis points (10000 = 100.00%). */
  porcentajeBp: number;
  /** Aporte directo adicional efectuado en el momento de la compra (opcional, 0 si una sola persona pagó todo). */
  aporteDirectoEnCompraCentimos: MontoMinor;
}

export interface GastoCompartido {
  id: string;
  /** Evento opcional al que pertenece el gasto compartido (puede ser de un viaje o cotidiano sin evento). */
  eventoId: string | null;
  descripcion: string;
  fechaGasto: string; // YYYY-MM-DD
  importeTotalCentimos: MontoMinor;
  /** Participante principal que pagó la cuenta en el establecimiento. */
  pagadoPorParticipanteId: string;
  /**
   * Si pagó el usuario titular ("Yo"), referencia al MovimientoFinanciero real en su cuenta.
   * Nunca se duplica la transacción real.
   */
  movimientoRealId: string | null;
  cuotas: CuotaParticipanteGasto[];
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

/**
 * Registro de un pago parcial o liquidación de deuda entre dos participantes.
 */
export interface LiquidacionCompartida {
  id: string;
  eventoId: string | null;
  gastoCompartidoId: string | null;
  fechaLiquidacion: string; // YYYY-MM-DD
  /** Quien entrega el dinero para saldar total o parcialmente su deuda. */
  deudorParticipanteId: string;
  /** Quien recibe el dinero. */
  acreedorParticipanteId: string;
  montoCentimos: MontoMinor;
  /**
   * Si el usuario titular ("Yo") recibe o envía el dinero desde una de sus cuentas,
   * referencia opcional al movimiento real registrado en su cuenta.
   */
  movimientoRealId: string | null;
  nota: string | null;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

/** Construye cuotas equitativas exactas sin perder ni inventar céntimos. */
export function construirCuotasEquitativas(
  importeTotalCentimos: MontoMinor,
  participantesIds: readonly string[],
): CuotaParticipanteGasto[] {
  assertMontoEntero(importeTotalCentimos, 'importeTotalCentimos');
  if (importeTotalCentimos <= 0) throw new Error('El importe total del gasto compartido debe ser positivo');
  if (participantesIds.length === 0) throw new Error('Se requiere al menos un participante');
  const montos = repartirEquitativo(importeTotalCentimos, participantesIds.length);
  const bps = repartirEquitativo(10000, participantesIds.length);
  return participantesIds.map((pid, i) => ({
    participanteId: pid,
    importeCorrespondienteCentimos: montos[i]!,
    porcentajeBp: bps[i]!,
    aporteDirectoEnCompraCentimos: 0,
  }));
}

/** Construye cuotas según porcentajes en basis points (cuya suma debe ser 10000 = 100%). */
export function construirCuotasPorPorcentaje(
  importeTotalCentimos: MontoMinor,
  porcentajesBp: readonly { participanteId: string; porcentajeBp: number }[],
): CuotaParticipanteGasto[] {
  assertMontoEntero(importeTotalCentimos, 'importeTotalCentimos');
  if (importeTotalCentimos <= 0) throw new Error('El importe total del gasto compartido debe ser positivo');
  const sumaBp = porcentajesBp.reduce((a, b) => a + b.porcentajeBp, 0);
  if (sumaBp !== 10000) {
    throw new Error(`Los porcentajes deben sumar exactamente 100.00% (10000 bp); suman ${sumaBp} bp`);
  }
  const montos = repartirProporcional(
    importeTotalCentimos,
    porcentajesBp.map((p) => p.porcentajeBp),
  );
  return porcentajesBp.map((p, i) => ({
    participanteId: p.participanteId,
    importeCorrespondienteCentimos: montos[i]!,
    porcentajeBp: p.porcentajeBp,
    aporteDirectoEnCompraCentimos: 0,
  }));
}

export function validarGastoCompartido(g: GastoCompartido): void {
  if (!g.id.trim()) throw new Error('Falta id del gasto compartido');
  if (!g.descripcion.trim()) throw new Error('La descripción del gasto compartido es obligatoria');
  if (!esFechaContableValida(g.fechaGasto)) throw new Error(`Fecha inválida: "${g.fechaGasto}"`);
  assertMontoEntero(g.importeTotalCentimos, 'importeTotalCentimos');
  if (g.importeTotalCentimos <= 0) throw new Error('El importe total debe ser mayor que cero');
  if (!g.pagadoPorParticipanteId.trim()) throw new Error('Debe indicar quién pagó el gasto');
  if (g.cuotas.length === 0) throw new Error('El gasto compartido debe tener al menos un participante');

  const sumaCuotas = sumarMontos(g.cuotas.map((c) => c.importeCorrespondienteCentimos));
  if (sumaCuotas !== g.importeTotalCentimos) {
    throw new Error(
      `La suma de las partes (${sumaCuotas}) debe coincidir exactamente con el importe total (${g.importeTotalCentimos})`,
    );
  }
  const sumaAportesAdicionales = sumarMontos(g.cuotas.map((c) => c.aporteDirectoEnCompraCentimos));
  if (sumaAportesAdicionales > g.importeTotalCentimos) {
    throw new Error('Los aportes directos en compra no pueden superar el importe total del gasto');
  }
}

export function validarLiquidacionCompartida(liq: LiquidacionCompartida): void {
  if (!liq.id.trim()) throw new Error('Falta id de la liquidación');
  if (!esFechaContableValida(liq.fechaLiquidacion)) {
    throw new Error(`Fecha de liquidación inválida: "${liq.fechaLiquidacion}"`);
  }
  if (!liq.deudorParticipanteId.trim() || !liq.acreedorParticipanteId.trim()) {
    throw new Error('Debe especificar deudor y acreedor');
  }
  if (liq.deudorParticipanteId === liq.acreedorParticipanteId) {
    throw new Error('El deudor y el acreedor deben ser participantes distintos');
  }
  assertMontoEntero(liq.montoCentimos, 'montoCentimos');
  if (liq.montoCentimos <= 0) throw new Error('El monto de la liquidación debe ser positivo');
}

export interface BalanceParticipante {
  participanteId: string;
  nombre: string;
  esUsuarioTitular: boolean;
  /** Total desembolsado en compras + liquidaciones entregadas a otros - liquidaciones recibidas de otros. */
  totalAportadoNetoCentimos: MontoMinor;
  /** Suma de las cuotas que le corresponden asumir en los gastos compartidos. */
  parteQueCorrespondeCentimos: MontoMinor;
  /** Total pagado directamente en caja en compras grupales. */
  pagadoEnComprasCentimos: MontoMinor;
  /** Liquidaciones entregadas a otros participantes. */
  liquidacionesPagadasCentimos: MontoMinor;
  /** Liquidaciones recibidas de otros participantes. */
  liquidacionesRecibidasCentimos: MontoMinor;
  /**
   * Saldo neto = totalAportadoNeto - parteQueCorresponde.
   *  > 0 : a este participante le deben ese monto.
   *  < 0 : este participante debe `Math.abs(saldoNetoCentimos)`.
   *  = 0 : está en paz.
   */
  saldoNetoCentimos: MontoMinor;
}

export interface InstruccionLiquidacionPendiente {
  deudorId: string;
  nombreDeudor: string;
  acreedorId: string;
  nombreAcreedor: string;
  montoPendienteCentimos: MontoMinor;
}

export interface ResumenPerspectivaUsuario {
  /** Dinero real que salió del bolsillo del usuario titular (compras pagadas por mí + liquidaciones pagadas por mí). */
  dineroSalioDeMiBolsilloCentimos: MontoMinor;
  /** Dinero ya recuperado mediante reembolsos/liquidaciones efectivamente recibidas. */
  reembolsosRecibidosCentimos: MontoMinor;
  /** Parte del gasto que realmente me corresponde asumir como gasto propio. */
  parteGastoQueMeCorrespondeCentimos: MontoMinor;
  /** Dinero que otras personas me deben actualmente (NO es un ingreso real hasta cobrarlo). */
  dineroQueMeDebenCentimos: MontoMinor;
  /** Dinero que yo debo actualmente a otras personas. */
  dineroQueDeboCentimos: MontoMinor;
}

export interface ResumenGastosCompartidos {
  origen: 'DERIVADO';
  totalGastosCompartidosCentimos: MontoMinor;
  totalLiquidadoCentimos: MontoMinor;
  balancesPorParticipante: BalanceParticipante[];
  quienDebeAQuien: InstruccionLiquidacionPendiente[];
  perspectivaUsuario: ResumenPerspectivaUsuario;
}

/**
 * Calcula los saldos por participante, quién debe a quién y las 4 magnitudes
 * exigidas para el usuario titular, soportando pagos parciales y liquidaciones.
 */
export function calcularSaldosYDeudasCompartidas(params: {
  participantes: readonly ParticipanteEvento[];
  gastosCompartidos: readonly GastoCompartido[];
  liquidaciones: readonly LiquidacionCompartida[];
}): ResumenGastosCompartidos {
  const gastosActivos = params.gastosCompartidos.filter((g) => g.estado === 'ACTIVO');
  const liquidacionesActivas = params.liquidaciones.filter((l) => l.estado === 'ACTIVO');

  // Construir catálogo unificado de participantes (asegurando al usuario titular)
  const mapaParticipantes = new Map<string, ParticipanteEvento>();
  for (const p of params.participantes) {
    mapaParticipantes.set(p.id, p);
  }
  if (![...mapaParticipantes.values()].some((p) => p.esUsuarioTitular)) {
    mapaParticipantes.set('yo', { id: 'yo', nombre: 'Yo', esUsuarioTitular: true });
  }

  for (const g of gastosActivos) {
    validarGastoCompartido(g);
    if (!mapaParticipantes.has(g.pagadoPorParticipanteId)) {
      mapaParticipantes.set(g.pagadoPorParticipanteId, {
        id: g.pagadoPorParticipanteId,
        nombre: g.pagadoPorParticipanteId,
        esUsuarioTitular: false,
      });
    }
    for (const c of g.cuotas) {
      if (!mapaParticipantes.has(c.participanteId)) {
        mapaParticipantes.set(c.participanteId, {
          id: c.participanteId,
          nombre: c.participanteId,
          esUsuarioTitular: false,
        });
      }
    }
  }

  for (const l of liquidacionesActivas) {
    validarLiquidacionCompartida(l);
  }

  const pagadoEnCompras = new Map<string, MontoMinor[]>();
  const parteCorrespondiente = new Map<string, MontoMinor[]>();
  const liqPagadas = new Map<string, MontoMinor[]>();
  const liqRecibidas = new Map<string, MontoMinor[]>();

  for (const g of gastosActivos) {
    const sumaAportesOtros = sumarMontos(g.cuotas.map((c) => c.aporteDirectoEnCompraCentimos));
    const pagadoPrincipal = sumarMontos([g.importeTotalCentimos, -sumaAportesOtros]);
    const arrPagador = pagadoEnCompras.get(g.pagadoPorParticipanteId) ?? [];
    arrPagador.push(pagadoPrincipal);
    pagadoEnCompras.set(g.pagadoPorParticipanteId, arrPagador);

    for (const c of g.cuotas) {
      if (c.aporteDirectoEnCompraCentimos > 0) {
        const arrAp = pagadoEnCompras.get(c.participanteId) ?? [];
        arrAp.push(c.aporteDirectoEnCompraCentimos);
        pagadoEnCompras.set(c.participanteId, arrAp);
      }
      const arrCuota = parteCorrespondiente.get(c.participanteId) ?? [];
      arrCuota.push(c.importeCorrespondienteCentimos);
      parteCorrespondiente.set(c.participanteId, arrCuota);
    }
  }

  for (const l of liquidacionesActivas) {
    const arrDeudor = liqPagadas.get(l.deudorParticipanteId) ?? [];
    arrDeudor.push(l.montoCentimos);
    liqPagadas.set(l.deudorParticipanteId, arrDeudor);

    const arrAcreedor = liqRecibidas.get(l.acreedorParticipanteId) ?? [];
    arrAcreedor.push(l.montoCentimos);
    liqRecibidas.set(l.acreedorParticipanteId, arrAcreedor);
  }

  const balancesPorParticipante: BalanceParticipante[] = [...mapaParticipantes.values()].map((p) => {
    const compras = sumarMontos(pagadoEnCompras.get(p.id) ?? []);
    const corresponde = sumarMontos(parteCorrespondiente.get(p.id) ?? []);
    const entregadas = sumarMontos(liqPagadas.get(p.id) ?? []);
    const recibidas = sumarMontos(liqRecibidas.get(p.id) ?? []);
    const aportadoNeto = sumarMontos([compras, entregadas, -recibidas]);
    const saldoNeto = sumarMontos([aportadoNeto, -corresponde]);

    return {
      participanteId: p.id,
      nombre: p.nombre,
      esUsuarioTitular: p.esUsuarioTitular,
      totalAportadoNetoCentimos: aportadoNeto,
      parteQueCorrespondeCentimos: corresponde,
      pagadoEnComprasCentimos: compras,
      liquidacionesPagadasCentimos: entregadas,
      liquidacionesRecibidasCentimos: recibidas,
      saldoNetoCentimos: saldoNeto,
    };
  });

  // Algoritmo determinista para simplificar quién debe a quién
  const deudores = balancesPorParticipante
    .filter((b) => b.saldoNetoCentimos < 0)
    .map((b) => ({ id: b.participanteId, nombre: b.nombre, faltaPagar: Math.abs(b.saldoNetoCentimos) }))
    .sort((a, b) => b.faltaPagar - a.faltaPagar);

  const acreedores = balancesPorParticipante
    .filter((b) => b.saldoNetoCentimos > 0)
    .map((b) => ({ id: b.participanteId, nombre: b.nombre, porCobrar: b.saldoNetoCentimos }))
    .sort((a, b) => b.porCobrar - a.porCobrar);

  const quienDebeAQuien: InstruccionLiquidacionPendiente[] = [];
  let i = 0;
  let j = 0;
  while (i < deudores.length && j < acreedores.length) {
    const d = deudores[i]!;
    const a = acreedores[j]!;
    const monto = Math.min(d.faltaPagar, a.porCobrar);
    if (monto > 0) {
      quienDebeAQuien.push({
        deudorId: d.id,
        nombreDeudor: d.nombre,
        acreedorId: a.id,
        nombreAcreedor: a.nombre,
        montoPendienteCentimos: monto,
      });
    }
    d.faltaPagar -= monto;
    a.porCobrar -= monto;
    if (d.faltaPagar === 0) i++;
    if (a.porCobrar === 0) j++;
  }

  const titular =
    balancesPorParticipante.find((b) => b.esUsuarioTitular) ?? balancesPorParticipante[0]!;
  const dineroSalioDeMiBolsillo = sumarMontos([
    titular.pagadoEnComprasCentimos,
    titular.liquidacionesPagadasCentimos,
  ]);
  const dineroQueMeDeben = titular.saldoNetoCentimos > 0 ? titular.saldoNetoCentimos : 0;
  const dineroQueDebo = titular.saldoNetoCentimos < 0 ? Math.abs(titular.saldoNetoCentimos) : 0;

  return {
    origen: 'DERIVADO',
    totalGastosCompartidosCentimos: sumarMontos(gastosActivos.map((g) => g.importeTotalCentimos)),
    totalLiquidadoCentimos: sumarMontos(liquidacionesActivas.map((l) => l.montoCentimos)),
    balancesPorParticipante,
    quienDebeAQuien,
    perspectivaUsuario: {
      dineroSalioDeMiBolsilloCentimos: dineroSalioDeMiBolsillo,
      reembolsosRecibidosCentimos: titular.liquidacionesRecibidasCentimos,
      parteGastoQueMeCorrespondeCentimos: titular.parteQueCorrespondeCentimos,
      dineroQueMeDebenCentimos: dineroQueMeDeben,
      dineroQueDeboCentimos: dineroQueDebo,
    },
  };
}
