/**
 * Módulo 6 de Fase 2: Reglas de Recurrencia y Calendario Financiero.
 *
 * REGLA INNEGOCIABLE:
 *  - Una regla recurrente representa únicamente una PREVISIÓN (`origen: 'PROYECTADO'`).
 *  - NUNCA registra automáticamente un gasto o ingreso real en la base de datos.
 *  - Solo cuando el usuario autoriza explícitamente una ocurrencia concreta, se crea
 *    el movimiento real y se marca esa fecha como materializada en la regla.
 */
import { assertMontoEntero, type MontoMinor } from './dinero';
import { diasEnMes, esFechaContableValida, sumarDias } from './fechas';
import type { EventoUniversal, GastoPlanificadoEvento } from './eventos';
import type { EstadoRegistro, MetadatosAuditoria } from './libro';

export const FRECUENCIAS_RECURRENCIA = [
  'SEMANAL',
  'MENSUAL',
  'ANUAL',
  'PERSONALIZADA_DIAS',
] as const;
export type FrecuenciaRecurrencia = (typeof FRECUENCIAS_RECURRENCIA)[number];

export interface ReglaRecurrencia {
  id: string;
  nombre: string;
  tipo: 'GASTO' | 'INGRESO';
  montoEstimadoCentimos: MontoMinor;
  cuentaId: string;
  categoriaId: string;
  subcategoriaId: string | null;
  eventoId: string | null;
  frecuencia: FrecuenciaRecurrencia;
  /** Usado cuando frecuencia === 'PERSONALIZADA_DIAS' (ej. cada 14 o 15 días). */
  intervaloDias: number | null;
  fechaInicio: string; // YYYY-MM-DD
  fechaFin: string | null; // YYYY-MM-DD opcional
  etiquetas: string[];
  /** Fechas ("YYYY-MM-DD") ya autorizadas y convertidas en movimiento real por el usuario. */
  fechasMaterializadas: Record<string, string>; // fecha -> movimientoRealId
  /** Fechas ("YYYY-MM-DD") omitidas explícitamente por el usuario. */
  fechasOmitidas: string[];
  activa: boolean;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export function validarReglaRecurrencia(r: ReglaRecurrencia): void {
  if (!r.id.trim()) throw new Error('Falta id de la regla de recurrencia');
  if (!r.nombre.trim()) throw new Error('El nombre del compromiso recurrente es obligatorio');
  assertMontoEntero(r.montoEstimadoCentimos, 'montoEstimadoCentimos');
  if (r.montoEstimadoCentimos <= 0) {
    throw new Error('El monto estimado de la regla recurrente debe ser mayor que cero');
  }
  if (!esFechaContableValida(r.fechaInicio)) {
    throw new Error(`Fecha de inicio inválida: "${r.fechaInicio}"`);
  }
  if (r.fechaFin && (!esFechaContableValida(r.fechaFin) || r.fechaFin < r.fechaInicio)) {
    throw new Error('Fecha de fin de recurrencia inválida');
  }
  if (r.frecuencia === 'PERSONALIZADA_DIAS') {
    if (!r.intervaloDias || !Number.isSafeInteger(r.intervaloDias) || r.intervaloDias < 1) {
      throw new Error('Para frecuencia personalizada debe indicar un intervalo en días >= 1');
    }
  }
}

function avanzarFechaRecurrente(
  fechaInicio: string,
  frecuencia: FrecuenciaRecurrencia,
  paso: number,
  intervaloDias: number | null,
): string {
  if (paso === 0) return fechaInicio;
  if (frecuencia === 'SEMANAL') {
    return sumarDias(fechaInicio, paso * 7);
  }
  if (frecuencia === 'PERSONALIZADA_DIAS') {
    return sumarDias(fechaInicio, paso * (intervaloDias ?? 1));
  }
  const [y0, m0, d0] = fechaInicio.split('-').map(Number) as [number, number, number];
  if (frecuencia === 'MENSUAL') {
    const totalMeses = (y0 * 12 + (m0 - 1)) + paso;
    const nuevoAnio = Math.floor(totalMeses / 12);
    const nuevoMes = (totalMeses % 12) + 1;
    const diaAjustado = Math.min(d0, diasEnMes(nuevoAnio, nuevoMes));
    return `${String(nuevoAnio).padStart(4, '0')}-${String(nuevoMes).padStart(2, '0')}-${String(diaAjustado).padStart(2, '0')}`;
  }
  // ANUAL
  const nuevoAnio = y0 + paso;
  const diaAjustado = Math.min(d0, diasEnMes(nuevoAnio, m0));
  return `${String(nuevoAnio).padStart(4, '0')}-${String(m0).padStart(2, '0')}-${String(diaAjustado).padStart(2, '0')}`;
}

export interface OcurrenciaRecurrenteProyectada {
  origen: 'PROYECTADO';
  reglaId: string;
  nombreRegla: string;
  fechaProgramada: string;
  tipo: 'GASTO' | 'INGRESO';
  montoEstimadoCentimos: MontoMinor;
  cuentaId: string;
  categoriaId: string;
  subcategoriaId: string | null;
  eventoId: string | null;
  etiquetas: string[];
  estadoOcurrencia: 'PENDIENTE_AUTORIZACION' | 'AUTORIZADA_REGISTRADA' | 'OMITIDA';
  movimientoRealId: string | null;
}

/**
 * Genera las ocurrencias proyectadas de una regla de recurrencia dentro de la ventana
 * `[desde, hasta]`. No escribe en la base de datos ni crea movimientos reales.
 */
export function proyectarOcurrenciasRegla(
  regla: ReglaRecurrencia,
  desde: string,
  hasta: string,
): OcurrenciaRecurrenteProyectada[] {
  validarReglaRecurrencia(regla);
  if (regla.estado !== 'ACTIVO' || !regla.activa) return [];
  if (hasta < regla.fechaInicio) return [];
  if (regla.fechaFin && desde > regla.fechaFin) return [];

  const omitidas = new Set(regla.fechasOmitidas);
  const ocurrencias: OcurrenciaRecurrenteProyectada[] = [];

  for (let paso = 0; paso <= 2000; paso++) {
    const fecha = avanzarFechaRecurrente(
      regla.fechaInicio,
      regla.frecuencia,
      paso,
      regla.intervaloDias,
    );
    if (fecha > hasta) break;
    if (regla.fechaFin && fecha > regla.fechaFin) break;
    if (fecha < desde) continue;

    const movRealId = regla.fechasMaterializadas[fecha] ?? null;
    const estadoOcurrencia: OcurrenciaRecurrenteProyectada['estadoOcurrencia'] = movRealId
      ? 'AUTORIZADA_REGISTRADA'
      : omitidas.has(fecha)
        ? 'OMITIDA'
        : 'PENDIENTE_AUTORIZACION';

    ocurrencias.push({
      origen: 'PROYECTADO',
      reglaId: regla.id,
      nombreRegla: regla.nombre,
      fechaProgramada: fecha,
      tipo: regla.tipo,
      montoEstimadoCentimos: regla.montoEstimadoCentimos,
      cuentaId: regla.cuentaId,
      categoriaId: regla.categoriaId,
      subcategoriaId: regla.subcategoriaId,
      eventoId: regla.eventoId,
      etiquetas: regla.etiquetas,
      estadoOcurrencia,
      movimientoRealId: movRealId,
    });
  }

  return ocurrencias;
}

export type TipoHitoCalendario =
  | 'INICIO_EVENTO'
  | 'FIN_EVENTO'
  | 'GASTO_PLANIFICADO'
  | 'COMPROMISO_PRESUPUESTARIO'
  | 'FECHA_PAGO_RECURRENTE';

export interface HitoCalendarioFinanciero {
  id: string;
  fecha: string; // YYYY-MM-DD
  tipoHito: TipoHitoCalendario;
  titulo: string;
  subtitulo: string;
  montoCentimos: MontoMinor | null;
  origen: 'PROYECTADO' | 'DERIVADO';
  referenciaId: string;
  eventoId: string | null;
  yaMaterializado: boolean;
}

/**
 * Construye la agenda del calendario financiero para el rango `[desde, hasta]`,
 * reuniendo próximos viajes, eventos personales, gastos planificados, compromisos
 * presupuestarios y fechas de pago de reglas recurrentes.
 */
export function construirAgendaCalendario(params: {
  desde: string;
  hasta: string;
  eventos: readonly EventoUniversal[];
  gastosPlanificados: readonly GastoPlanificadoEvento[];
  reglasRecurrencia: readonly ReglaRecurrencia[];
}): HitoCalendarioFinanciero[] {
  const hitos: HitoCalendarioFinanciero[] = [];

  for (const ev of params.eventos.filter((e) => e.estado === 'ACTIVO' && e.estadoEvento !== 'CANCELADO')) {
    if (ev.fechaInicio >= params.desde && ev.fechaInicio <= params.hasta) {
      hitos.push({
        id: `ev-ini-${ev.id}`,
        fecha: ev.fechaInicio,
        tipoHito: 'INICIO_EVENTO',
        titulo: `Inicio: ${ev.nombre}`,
        subtitulo: `${ev.tipoEvento}${ev.ubicacion ? ` · ${ev.ubicacion}` : ''}`,
        montoCentimos: ev.presupuestoTotalCentimos > 0 ? ev.presupuestoTotalCentimos : null,
        origen: 'DERIVADO',
        referenciaId: ev.id,
        eventoId: ev.id,
        yaMaterializado: ev.estadoEvento === 'ACTIVO' || ev.estadoEvento === 'FINALIZADO',
      });
    }
    if (ev.fechaFin !== ev.fechaInicio && ev.fechaFin >= params.desde && ev.fechaFin <= params.hasta) {
      hitos.push({
        id: `ev-fin-${ev.id}`,
        fecha: ev.fechaFin,
        tipoHito: 'FIN_EVENTO',
        titulo: `Cierre: ${ev.nombre}`,
        subtitulo: ev.tipoEvento,
        montoCentimos: null,
        origen: 'DERIVADO',
        referenciaId: ev.id,
        eventoId: ev.id,
        yaMaterializado: ev.estadoEvento === 'FINALIZADO',
      });
    }
  }

  for (const gp of params.gastosPlanificados.filter((g) => g.estado === 'ACTIVO')) {
    if (gp.fechaPrevista >= params.desde && gp.fechaPrevista <= params.hasta) {
      hitos.push({
        id: `plan-${gp.id}`,
        fecha: gp.fechaPrevista,
        tipoHito:
          gp.estadoPlanificacion === 'COMPROMETIDO'
            ? 'COMPROMISO_PRESUPUESTARIO'
            : 'GASTO_PLANIFICADO',
        titulo: gp.concepto,
        subtitulo: `Estado: ${gp.estadoPlanificacion}`,
        montoCentimos: gp.montoEstimadoCentimos,
        origen: 'PROYECTADO',
        referenciaId: gp.id,
        eventoId: gp.eventoId,
        yaMaterializado: gp.estadoPlanificacion === 'REGISTRADO',
      });
    }
  }

  for (const regla of params.reglasRecurrencia) {
    const ocs = proyectarOcurrenciasRegla(regla, params.desde, params.hasta);
    for (const oc of ocs) {
      if (oc.estadoOcurrencia === 'OMITIDA') continue;
      hitos.push({
        id: `rec-${regla.id}-${oc.fechaProgramada}`,
        fecha: oc.fechaProgramada,
        tipoHito: 'FECHA_PAGO_RECURRENTE',
        titulo: oc.nombreRegla,
        subtitulo: `Recurrente (${regla.frecuencia}) · ${
          oc.estadoOcurrencia === 'AUTORIZADA_REGISTRADA'
            ? 'Ya registrado'
            : 'Previsión — requiere autorización'
        }`,
        montoCentimos: oc.montoEstimadoCentimos,
        origen: 'PROYECTADO',
        referenciaId: regla.id,
        eventoId: regla.eventoId,
        yaMaterializado: oc.estadoOcurrencia === 'AUTORIZADA_REGISTRADA',
      });
    }
  }

  return hitos.sort((a, b) => (a.fecha === b.fecha ? a.titulo.localeCompare(b.titulo) : a.fecha.localeCompare(b.fecha)));
}
