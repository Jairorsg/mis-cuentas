/**
 * Módulo 1, 2, 3 y 4 de Fase 2:
 * Gestión Universal de Eventos, Presupuestos por Evento, Control Diario (Burn Rate)
 * y Planificación (Planificado vs. Comprometido vs. Registrado sin doble conteo).
 *
 * Trabaja directamente sobre `MovimientoFinanciero` del núcleo (`libro.ts`)
 * vinculando las transacciones reales mediante `eventoId` (`event_id`) y
 * `partidaEventoId`, sin duplicar jamás una transacción.
 */
import { assertMontoEntero, dividirMitadPar, type MontoMinor, sumarMontos } from './dinero';
import { diferenciaDias, esFechaContableValida } from './fechas';
import type { EstadoRegistro, MetadatosAuditoria, MovimientoFinanciero } from './libro';
import { normalizarEtiquetas } from './libro';
import { esMonedaConocida, MONEDA_PRINCIPAL } from './monedas';

export const TIPOS_EVENTO_INICIALES = [
  'VIAJE',
  'CELEBRACION',
  'COMPRA_IMPORTANTE',
  'PROYECTO',
  'ACTIVIDAD_PERSONAL',
  'OTRO',
] as const;
export type TipoEventoSugerido = (typeof TIPOS_EVENTO_INICIALES)[number];

export const ESTADOS_EVENTO_UNIVERSAL = [
  'PLANIFICADO',
  'ACTIVO',
  'FINALIZADO',
  'CANCELADO',
] as const;
export type EstadoEventoUniversal = (typeof ESTADOS_EVENTO_UNIVERSAL)[number];

/** Partida o categoría presupuestaria independiente dentro de un evento. */
export interface PartidaPresupuestoEvento {
  id: string;
  nombre: string;
  asignadoCentimos: MontoMinor;
  /** Vínculo opcional con una categoría general del libro para mapeo automático. */
  categoriaLibroId?: string | null;
}

/** Participante registrado para gastos grupales o de un evento. */
export interface ParticipanteEvento {
  id: string;
  nombre: string;
  esUsuarioTitular: boolean;
}

/**
 * Plantillas iniciales de categorías presupuestarias para eventos de tipo VIAJE
 * (modificables, agregables y eliminables libremente por el usuario).
 */
export const PLANTILLAS_PARTIDAS_VIAJE: readonly { nombre: string }[] = Object.freeze([
  { nombre: 'Pasajes y transporte' },
  { nombre: 'Alojamiento' },
  { nombre: 'Alimentación' },
  { nombre: 'Compras y frontera' },
  { nombre: 'Imprevistos' },
]);

export interface EventoUniversal {
  id: string;
  nombre: string;
  /** Permite cualquiera de TIPOS_EVENTO_INICIALES o un tipo personalizado por el usuario. */
  tipoEvento: string;
  fechaInicio: string; // YYYY-MM-DD en America/Lima
  fechaFin: string; // YYYY-MM-DD en America/Lima (sin límite de días)
  ubicacion: string | null;
  presupuestoTotalCentimos: MontoMinor;
  moneda: string;
  partidasPresupuesto: PartidaPresupuestoEvento[];
  participantes: ParticipanteEvento[];
  etiquetas: string[];
  descripcion: string | null;
  estadoEvento: EstadoEventoUniversal;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export const ESTADOS_PLANIFICACION_GASTO = [
  'PLANIFICADO',
  'COMPROMETIDO',
  'REGISTRADO',
] as const;
export type EstadoPlanificacionGasto = (typeof ESTADOS_PLANIFICACION_GASTO)[number];

/**
 * Ítem de planificación de un evento (gasto previsto, actividad o compromiso).
 *
 * - PLANIFICADO  : estimación inicial (origen PROYECTADO).
 * - COMPROMETIDO : reserva o compromiso firme aún no pagado (origen PROYECTADO).
 * - REGISTRADO   : ya convertido en un `MovimientoFinanciero` real mediante `movimientoRealId`.
 *                  En este estado NO suma como planificado ni comprometido para
 *                  evitar contabilizar el importe dos veces.
 */
export interface GastoPlanificadoEvento {
  id: string;
  eventoId: string;
  partidaEventoId: string | null;
  concepto: string;
  montoEstimadoCentimos: MontoMinor;
  fechaPrevista: string; // YYYY-MM-DD
  estadoPlanificacion: EstadoPlanificacionGasto;
  /** ID del movimiento real en el libro único cuando estadoPlanificacion === 'REGISTRADO'. */
  movimientoRealId: string | null;
  notas: string | null;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export function validarEventoUniversal(ev: EventoUniversal): void {
  if (!ev.id.trim()) throw new Error('El identificador del evento es obligatorio');
  if (!ev.nombre.trim()) throw new Error('El nombre del evento es obligatorio');
  if (!ev.tipoEvento.trim()) throw new Error('El tipo de evento es obligatorio');
  if (!esFechaContableValida(ev.fechaInicio)) {
    throw new Error(`Fecha de inicio inválida: "${ev.fechaInicio}"`);
  }
  if (!esFechaContableValida(ev.fechaFin)) {
    throw new Error(`Fecha de fin inválida: "${ev.fechaFin}"`);
  }
  if (ev.fechaFin < ev.fechaInicio) {
    throw new Error('La fecha de fin del evento no puede ser anterior a la fecha de inicio');
  }
  if (!esMonedaConocida(ev.moneda)) {
    throw new Error(`Moneda no reconocida: "${ev.moneda}"`);
  }
  assertMontoEntero(ev.presupuestoTotalCentimos, 'presupuestoTotalCentimos');
  if (ev.presupuestoTotalCentimos < 0) {
    throw new Error('El presupuesto total del evento no puede ser negativo');
  }
  for (const p of ev.partidasPresupuesto) {
    if (!p.nombre.trim()) throw new Error('Toda categoría presupuestaria del evento requiere un nombre');
    assertMontoEntero(p.asignadoCentimos, `asignación de "${p.nombre}"`);
    if (p.asignadoCentimos < 0) {
      throw new Error(`La asignación de "${p.nombre}" no puede ser negativa`);
    }
  }
}

/** Normaliza un evento heredado de Fase 1 o nuevo al contrato completo de Fase 2. */
export function normalizarEventoUniversal(
  crudo: Partial<EventoUniversal> & {
    id: string;
    nombre: string;
    fechaInicio: string;
    fechaFin?: string | null;
    presupuestoCentimos?: MontoMinor | null;
    presupuestoTotalCentimos?: MontoMinor;
    estadoEvento?: string;
    estado: EstadoRegistro;
    auditoria: MetadatosAuditoria;
  },
): EventoUniversal {
  const fechaFin =
    crudo.fechaFin && esFechaContableValida(crudo.fechaFin) && crudo.fechaFin >= crudo.fechaInicio
      ? crudo.fechaFin
      : crudo.fechaInicio;
  const presupuestoTotal =
    crudo.presupuestoTotalCentimos !== undefined
      ? crudo.presupuestoTotalCentimos
      : (crudo.presupuestoCentimos ?? 0);
  const estadoEv = (ESTADOS_EVENTO_UNIVERSAL as readonly string[]).includes(String(crudo.estadoEvento))
    ? (crudo.estadoEvento as EstadoEventoUniversal)
    : 'ACTIVO';

  return {
    id: crudo.id,
    nombre: crudo.nombre.trim(),
    tipoEvento: crudo.tipoEvento?.trim() || 'OTRO',
    fechaInicio: crudo.fechaInicio,
    fechaFin,
    ubicacion: crudo.ubicacion?.trim() ? crudo.ubicacion.trim() : null,
    presupuestoTotalCentimos: presupuestoTotal,
    moneda: crudo.moneda && esMonedaConocida(crudo.moneda) ? crudo.moneda : MONEDA_PRINCIPAL,
    partidasPresupuesto: Array.isArray(crudo.partidasPresupuesto) ? crudo.partidasPresupuesto : [],
    participantes:
      Array.isArray(crudo.participantes) && crudo.participantes.length > 0
        ? crudo.participantes
        : [{ id: 'yo', nombre: 'Yo', esUsuarioTitular: true }],
    etiquetas: normalizarEtiquetas(crudo.etiquetas ?? []),
    descripcion: crudo.descripcion?.trim() ? crudo.descripcion.trim() : null,
    estadoEvento: estadoEv,
    estado: crudo.estado,
    auditoria: crudo.auditoria,
  };
}

export interface ResumenPartidaEvento {
  partidaId: string;
  nombre: string;
  asignadoCentimos: MontoMinor;
  gastoRealCentimos: MontoMinor;
  comprometidoCentimos: MontoMinor;
  planificadoPendienteCentimos: MontoMinor;
  disponibleCentimos: MontoMinor;
  excesoCentimos: MontoMinor;
  porcentajeConsumidoBp: number;
}

export interface ControlDiarioEvento {
  origen: 'DERIVADO';
  situacionTemporal: 'NO_INICIADO' | 'EN_CURSO' | 'FINALIZADO' | 'CANCELADO';
  diasTotalesEvento: number;
  diasTranscurridos: number;
  diasCalendarioRestantes: number;
  /** Saldo presupuestario disponible / días calendario restantes (céntimos enteros). */
  presupuestoDiarioRecomendadoCentimos: MontoMinor;
  /** Presupuesto diario base inicial = Presupuesto total / días totales. */
  ritmoObjetivoInicialDiarioCentimos: MontoMinor;
  /** Gasto real acumulado / días transcurridos (0 si aún no inició). */
  burnRateDiarioCentimos: MontoMinor;
  /** Diferencia (burnRateDiario - presupuestoDiarioRecomendado). Positivo = gastando más rápido de lo recomendado. */
  desviacionRitmoDiarioCentimos: MontoMinor;
  evaluacionRitmo: 'SIN_INICIAR' | 'DENTRO_DE_RITMO' | 'RITMO_EXCEDIDO' | 'PRESUPUESTO_AGOTADO' | 'EVENTO_CERRADO';
  mensajeRitmo: string;
}

export interface ResumenPresupuestoEvento {
  origen: 'DERIVADO';
  eventoId: string;
  presupuestoTotalCentimos: MontoMinor;
  presupuestoAsignadoCentimos: MontoMinor;
  presupuestoSinAsignarCentimos: MontoMinor;
  /** Suma de gastos reales activos en el libro cuyo `eventoId` coincide. */
  gastoRealCentimos: MontoMinor;
  /** Suma de ítems en estado COMPROMETIDO que aún NO tienen transacción real. */
  dineroComprometidoCentimos: MontoMinor;
  /** Suma de ítems en estado PLANIFICADO que aún NO están comprometidos ni registrados. */
  gastoPlanificadoPendienteCentimos: MontoMinor;
  /** Presupuesto total - Gasto real. */
  saldoDisponibleContableCentimos: MontoMinor;
  /** Presupuesto total - Gasto real - Dinero comprometido. */
  saldoDisponibleTrasCompromisosCentimos: MontoMinor;
  /** Porcentaje consumido por el gasto real en basis points (10000 = 100.00%). */
  porcentajeConsumidoBp: number;
  /** Porcentaje consumido incluyendo dinero comprometido en basis points. */
  porcentajeComprometidoYRealBp: number;
  /** Monto en que (gastoReal + dineroComprometido) supera al presupuestoTotal (0 si no hay exceso). */
  excesoPresupuestarioCentimos: MontoMinor;
  partidas: ResumenPartidaEvento[];
  gastoSinPartidaCentimos: MontoMinor;
  controlDiario: ControlDiarioEvento;
  movimientosRealesVinculados: MovimientoFinanciero[];
}

/**
 * Resuelve a qué partida presupuestaria de un evento pertenece un movimiento real:
 *  1. Si el movimiento fue originado por un `GastoPlanificadoEvento` con `partidaEventoId`, usa esa partida.
 *  2. Si alguna partida tiene `categoriaLibroId === mov.categoriaId` o el mismo nombre que la categoría, la asocia.
 */
function resolverPartidaDeMovimiento(
  mov: MovimientoFinanciero,
  evento: EventoUniversal,
  planificadosActivos: readonly GastoPlanificadoEvento[],
  mapaNombresCategorias: ReadonlyMap<string, string>,
): string | null {
  const planVinculado = planificadosActivos.find((p) => p.movimientoRealId === mov.id);
  if (planVinculado?.partidaEventoId) {
    return planVinculado.partidaEventoId;
  }
  for (const part of evento.partidasPresupuesto) {
    if (part.categoriaLibroId && part.categoriaLibroId === mov.categoriaId) {
      return part.id;
    }
  }
  const nombreCat = mov.categoriaId ? mapaNombresCategorias.get(mov.categoriaId) : undefined;
  if (nombreCat) {
    const coincidente = evento.partidasPresupuesto.find(
      (p) => p.nombre.trim().toLowerCase() === nombreCat.trim().toLowerCase(),
    );
    if (coincidente) return coincidente.id;
  }
  return null;
}

/**
 * Calcula todas las métricas presupuestarias, por partida y de control diario
 * (Burn Rate vs. Presupuesto diario recomendado) de un evento a partir de las
 * transacciones reales existentes y los ítems planificados.
 */
export function calcularResumenEvento(params: {
  evento: EventoUniversal;
  movimientos: readonly MovimientoFinanciero[];
  gastosPlanificados?: readonly GastoPlanificadoEvento[];
  mapaNombresCategorias?: ReadonlyMap<string, string>;
  fechaReferenciaLima?: string;
}): ResumenPresupuestoEvento {
  const {
    evento,
    movimientos,
    gastosPlanificados = [],
    mapaNombresCategorias = new Map<string, string>(),
    fechaReferenciaLima = evento.fechaInicio,
  } = params;

  validarEventoUniversal(evento);

  const movsEvento = movimientos.filter(
    (m) => m.estado === 'ACTIVO' && m.eventoId === evento.id && m.tipo === 'GASTO',
  );
  const idsMovimientosRealesActivos = new Set(
    movimientos.filter((m) => m.estado === 'ACTIVO').map((m) => m.id),
  );

  // Ítems planificados activos del evento.
  // REGLA ANTI-DOBLE CONTEO: si un ítem tiene `estadoPlanificacion === 'REGISTRADO'` y su
  // `movimientoRealId` existe como transacción activa, NO suma en planificado ni en comprometido.
  const planActivos = gastosPlanificados.filter(
    (g) => g.estado === 'ACTIVO' && g.eventoId === evento.id,
  );

  const comprometidosPendientes = planActivos.filter(
    (g) =>
      g.estadoPlanificacion === 'COMPROMETIDO' &&
      (!g.movimientoRealId || !idsMovimientosRealesActivos.has(g.movimientoRealId)),
  );
  const planificadosPendientes = planActivos.filter(
    (g) =>
      g.estadoPlanificacion === 'PLANIFICADO' &&
      (!g.movimientoRealId || !idsMovimientosRealesActivos.has(g.movimientoRealId)),
  );

  const gastoRealCentimos = sumarMontos(movsEvento.map((m) => m.montoCentimos));
  const dineroComprometidoCentimos = sumarMontos(
    comprometidosPendientes.map((g) => g.montoEstimadoCentimos),
  );
  const gastoPlanificadoPendienteCentimos = sumarMontos(
    planificadosPendientes.map((g) => g.montoEstimadoCentimos),
  );

  const presupuestoTotal = evento.presupuestoTotalCentimos;
  const presupuestoAsignado = sumarMontos(evento.partidasPresupuesto.map((p) => p.asignadoCentimos));
  const presupuestoSinAsignar = sumarMontos([presupuestoTotal, -presupuestoAsignado]);

  const saldoDisponibleContable = sumarMontos([presupuestoTotal, -gastoRealCentimos]);
  const saldoDisponibleTrasCompromisos = sumarMontos([
    presupuestoTotal,
    -gastoRealCentimos,
    -dineroComprometidoCentimos,
  ]);

  const porcentajeConsumidoBp =
    presupuestoTotal > 0
      ? Number((BigInt(gastoRealCentimos) * 10000n) / BigInt(presupuestoTotal))
      : 0;
  const totalRealMasComprometido = sumarMontos([gastoRealCentimos, dineroComprometidoCentimos]);
  const porcentajeComprometidoYRealBp =
    presupuestoTotal > 0
      ? Number((BigInt(totalRealMasComprometido) * 10000n) / BigInt(presupuestoTotal))
      : 0;

  const excesoPresupuestarioCentimos =
    totalRealMasComprometido > presupuestoTotal
      ? sumarMontos([totalRealMasComprometido, -presupuestoTotal])
      : 0;

  // Desglose por partida presupuestaria
  const realPorPartida = new Map<string, MontoMinor[]>();
  const sinPartida: MontoMinor[] = [];

  for (const m of movsEvento) {
    const pid = resolverPartidaDeMovimiento(m, evento, planActivos, mapaNombresCategorias);
    if (pid && evento.partidasPresupuesto.some((p) => p.id === pid)) {
      const arr = realPorPartida.get(pid) ?? [];
      arr.push(m.montoCentimos);
      realPorPartida.set(pid, arr);
    } else {
      sinPartida.push(m.montoCentimos);
    }
  }

  const partidas: ResumenPartidaEvento[] = evento.partidasPresupuesto.map((p) => {
    const real = sumarMontos(realPorPartida.get(p.id) ?? []);
    const comp = sumarMontos(
      comprometidosPendientes
        .filter((g) => g.partidaEventoId === p.id)
        .map((g) => g.montoEstimadoCentimos),
    );
    const plan = sumarMontos(
      planificadosPendientes
        .filter((g) => g.partidaEventoId === p.id)
        .map((g) => g.montoEstimadoCentimos),
    );
    const disp = sumarMontos([p.asignadoCentimos, -real, -comp]);
    const usado = sumarMontos([real, comp]);
    const exceso = usado > p.asignadoCentimos ? sumarMontos([usado, -p.asignadoCentimos]) : 0;
    const bp = p.asignadoCentimos > 0 ? Number((BigInt(real) * 10000n) / BigInt(p.asignadoCentimos)) : 0;
    return {
      partidaId: p.id,
      nombre: p.nombre,
      asignadoCentimos: p.asignadoCentimos,
      gastoRealCentimos: real,
      comprometidoCentimos: comp,
      planificadoPendienteCentimos: plan,
      disponibleCentimos: disp,
      excesoCentimos: exceso,
      porcentajeConsumidoBp: bp,
    };
  });

  const controlDiario = calcularControlDiarioEvento({
    evento,
    gastoRealCentimos,
    saldoDisponibleCentimos: saldoDisponibleTrasCompromisos,
    fechaReferenciaLima,
  });

  return {
    origen: 'DERIVADO',
    eventoId: evento.id,
    presupuestoTotalCentimos: presupuestoTotal,
    presupuestoAsignadoCentimos: presupuestoAsignado,
    presupuestoSinAsignarCentimos: presupuestoSinAsignar,
    gastoRealCentimos,
    dineroComprometidoCentimos,
    gastoPlanificadoPendienteCentimos,
    saldoDisponibleContableCentimos: saldoDisponibleContable,
    saldoDisponibleTrasCompromisosCentimos: saldoDisponibleTrasCompromisos,
    porcentajeConsumidoBp,
    porcentajeComprometidoYRealBp,
    excesoPresupuestarioCentimos,
    partidas,
    gastoSinPartidaCentimos: sumarMontos(sinPartida),
    controlDiario,
    movimientosRealesVinculados: movsEvento,
  };
}

/**
 * Calcula el Presupuesto Diario Recomendado y el Burn Rate Diario considerando:
 *  - Eventos no iniciados (`fechaReferenciaLima < fechaInicio` o `estadoEvento === 'PLANIFICADO'` antes de inicio).
 *  - Eventos activos / en curso (`fechaInicio <= fechaReferenciaLima <= fechaFin`).
 *  - Eventos finalizados o cancelados (`fechaReferenciaLima > fechaFin` o `estadoEvento IN ('FINALIZADO','CANCELADO')`).
 */
export function calcularControlDiarioEvento(params: {
  evento: EventoUniversal;
  gastoRealCentimos: MontoMinor;
  saldoDisponibleCentimos: MontoMinor;
  fechaReferenciaLima: string;
}): ControlDiarioEvento {
  const { evento, gastoRealCentimos, saldoDisponibleCentimos, fechaReferenciaLima } = params;
  const diasTotales = Math.max(1, diferenciaDias(evento.fechaInicio, evento.fechaFin) + 1);
  const ritmoObjetivoInicial = Number(
    dividirMitadPar(BigInt(evento.presupuestoTotalCentimos), BigInt(diasTotales)),
  );

  if (evento.estadoEvento === 'CANCELADO') {
    return {
      origen: 'DERIVADO',
      situacionTemporal: 'CANCELADO',
      diasTotalesEvento: diasTotales,
      diasTranscurridos: 0,
      diasCalendarioRestantes: 0,
      presupuestoDiarioRecomendadoCentimos: 0,
      ritmoObjetivoInicialDiarioCentimos: ritmoObjetivoInicial,
      burnRateDiarioCentimos: 0,
      desviacionRitmoDiarioCentimos: 0,
      evaluacionRitmo: 'EVENTO_CERRADO',
      mensajeRitmo: 'Evento cancelado.',
    };
  }

  if (evento.estadoEvento === 'FINALIZADO' || fechaReferenciaLima > evento.fechaFin) {
    const burnFinal = Number(dividirMitadPar(BigInt(gastoRealCentimos), BigInt(diasTotales)));
    return {
      origen: 'DERIVADO',
      situacionTemporal: 'FINALIZADO',
      diasTotalesEvento: diasTotales,
      diasTranscurridos: diasTotales,
      diasCalendarioRestantes: 0,
      presupuestoDiarioRecomendadoCentimos: 0,
      ritmoObjetivoInicialDiarioCentimos: ritmoObjetivoInicial,
      burnRateDiarioCentimos: burnFinal,
      desviacionRitmoDiarioCentimos: burnFinal - ritmoObjetivoInicial,
      evaluacionRitmo: 'EVENTO_CERRADO',
      mensajeRitmo:
        burnFinal <= ritmoObjetivoInicial
          ? 'Evento finalizado dentro del ritmo diario presupuestado.'
          : 'Evento finalizado con un ritmo diario superior al objetivo inicial.',
    };
  }

  if (fechaReferenciaLima < evento.fechaInicio) {
    const saldoPositivo = Math.max(0, saldoDisponibleCentimos);
    const recomendadoPreInicio = Number(
      dividirMitadPar(BigInt(saldoPositivo), BigInt(diasTotales)),
    );
    return {
      origen: 'DERIVADO',
      situacionTemporal: 'NO_INICIADO',
      diasTotalesEvento: diasTotales,
      diasTranscurridos: 0,
      diasCalendarioRestantes: diasTotales,
      presupuestoDiarioRecomendadoCentimos: recomendadoPreInicio,
      ritmoObjetivoInicialDiarioCentimos: ritmoObjetivoInicial,
      burnRateDiarioCentimos: 0,
      desviacionRitmoDiarioCentimos: 0,
      evaluacionRitmo: 'SIN_INICIAR',
      mensajeRitmo: `El evento inicia el ${evento.fechaInicio} (${diasTotales} día(s) planificados).`,
    };
  }

  // Evento en curso: fechaInicio <= fechaReferenciaLima <= fechaFin
  const diasTranscurridos = Math.max(1, diferenciaDias(evento.fechaInicio, fechaReferenciaLima) + 1);
  const diasCalendarioRestantes = Math.max(1, diferenciaDias(fechaReferenciaLima, evento.fechaFin) + 1);

  const burnRateDiario = Number(
    dividirMitadPar(BigInt(gastoRealCentimos), BigInt(diasTranscurridos)),
  );

  if (saldoDisponibleCentimos <= 0) {
    return {
      origen: 'DERIVADO',
      situacionTemporal: 'EN_CURSO',
      diasTotalesEvento: diasTotales,
      diasTranscurridos,
      diasCalendarioRestantes,
      presupuestoDiarioRecomendadoCentimos: 0,
      ritmoObjetivoInicialDiarioCentimos: ritmoObjetivoInicial,
      burnRateDiarioCentimos: burnRateDiario,
      desviacionRitmoDiarioCentimos: burnRateDiario,
      evaluacionRitmo: 'PRESUPUESTO_AGOTADO',
      mensajeRitmo: 'El presupuesto disponible del evento ya se agotó o fue superado.',
    };
  }

  const presupuestoDiarioRecomendado = Number(
    dividirMitadPar(BigInt(saldoDisponibleCentimos), BigInt(diasCalendarioRestantes)),
  );
  const desviacion = burnRateDiario - presupuestoDiarioRecomendado;
  const excedido = burnRateDiario > presupuestoDiarioRecomendado;

  return {
    origen: 'DERIVADO',
    situacionTemporal: 'EN_CURSO',
    diasTotalesEvento: diasTotales,
    diasTranscurridos,
    diasCalendarioRestantes,
    presupuestoDiarioRecomendadoCentimos: presupuestoDiarioRecomendado,
    ritmoObjetivoInicialDiarioCentimos: ritmoObjetivoInicial,
    burnRateDiarioCentimos: burnRateDiario,
    desviacionRitmoDiarioCentimos: desviacion,
    evaluacionRitmo: excedido ? 'RITMO_EXCEDIDO' : 'DENTRO_DE_RITMO',
    mensajeRitmo: excedido
      ? 'Atención: tu Burn Rate diario supera el presupuesto diario recomendado para los días restantes.'
      : 'Buen ritmo: tu Burn Rate diario está dentro del presupuesto diario recomendado.',
  };
}
