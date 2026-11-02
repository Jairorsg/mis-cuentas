/**
 * Fase 4 — Caché Determinista de Predicciones e Invalidación por Huella de Datos.
 *
 * Evita re-ejecutar backtesting de series temporales y 1,000 iteraciones de Monte Carlo
 * en cada render visual cuando las transacciones y configuraciones relevantes no han
 * cambiado, e invalida de inmediato la entrada en caché ante cualquier alta, edición
 * o eliminación lógica de transacciones, presupuestos o eventos.
 */
import type { EventoUniversal, GastoPlanificadoEvento } from '../eventos';
import type {
  CategoriaPersonalizada,
  CuentaMetodo,
  MovimientoFinanciero,
  PresupuestoCategoria,
} from '../libro';
import {
  ejecutarMotorPrediccionesYRiesgo,
  type ReportePrediccionesYRiesgo,
} from './proyecciones';

export interface EntradaMotorConCache {
  periodoMes: string;
  fechaCorteLima: string;
  movimientos: readonly MovimientoFinanciero[];
  cuentas: readonly CuentaMetodo[];
  categorias: readonly CategoriaPersonalizada[];
  presupuestos: readonly PresupuestoCategoria[];
  eventos: readonly EventoUniversal[];
  gastosPlanificados: readonly GastoPlanificadoEvento[];
  umbralZAnomalias?: number;
  iteracionesMonteCarlo?: number;
}

/**
 * Calcula una huella (fingerprint) rápida sobre el estado de las colecciones
 * financieras que afectan las proyecciones, intervalos, Monte Carlo y anomalías.
 */
export function calcularHuellaDatosPrediccion(entrada: EntradaMotorConCache): string {
  const fnv1a = (partes: string[]): string => {
    let h = 0x811c9dc5;
    for (const p of partes) {
      for (let i = 0; i < p.length; i++) {
        h ^= p.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return (h >>> 0).toString(16);
  };

  const partes: string[] = [
    `P:${entrada.periodoMes}`,
    `C:${entrada.fechaCorteLima}`,
    `Z:${entrada.umbralZAnomalias ?? 2.0}`,
    `MC:${entrada.iteracionesMonteCarlo ?? 1000}`,
    `M_LEN:${entrada.movimientos.length}`,
  ];

  for (const m of entrada.movimientos) {
    partes.push(
      `M:${m.id}:${m.estado}:${m.tipo}:${m.fechaMovimiento}:${m.montoCentimos}:${m.categoriaId ?? ''}:${m.eventoId ?? ''}:${m.auditoria.version}`,
    );
  }
  for (const p of entrada.presupuestos) {
    partes.push(`PR:${p.id}:${p.estado}:${p.periodoMes}:${p.categoriaId}:${p.limiteCentimos}:${p.auditoria.version}`);
  }
  for (const e of entrada.eventos) {
    partes.push(
      `EV:${e.id}:${e.estado}:${e.estadoEvento}:${e.fechaInicio}:${e.fechaFin}:${e.presupuestoTotalCentimos}:${e.auditoria.version}`,
    );
  }
  for (const gp of entrada.gastosPlanificados) {
    partes.push(
      `GP:${gp.id}:${gp.estado}:${gp.eventoId}:${gp.estadoPlanificacion}:${gp.montoEstimadoCentimos}:${gp.movimientoRealId ?? ''}`,
    );
  }
  for (const c of entrada.cuentas) {
    partes.push(`CT:${c.id}:${c.estado}:${c.auditoria.version}`);
  }
  for (const cat of entrada.categorias) {
    partes.push(`CA:${cat.id}:${cat.estado}:${cat.nombre}:${cat.auditoria.version}`);
  }

  return `${entrada.periodoMes}|${entrada.movimientos.length}|${fnv1a(partes)}`;
}

export class CachePrediccionesFinancieras {
  private ultimaHuella: string | null = null;
  private ultimoReporte: ReportePrediccionesYRiesgo | null = null;
  private ejecucionesReales = 0;
  private aciertosCache = 0;

  obtenerOCalcular(entrada: EntradaMotorConCache): {
    reporte: ReportePrediccionesYRiesgo;
    huella: string;
    desdeCache: boolean;
    estadisticasCache: { ejecucionesReales: number; aciertosCache: number };
  } {
    const huella = calcularHuellaDatosPrediccion(entrada);
    if (this.ultimaHuella === huella && this.ultimoReporte !== null) {
      this.aciertosCache += 1;
      return {
        reporte: this.ultimoReporte,
        huella,
        desdeCache: true,
        estadisticasCache: {
          ejecucionesReales: this.ejecucionesReales,
          aciertosCache: this.aciertosCache,
        },
      };
    }

    const reporte = ejecutarMotorPrediccionesYRiesgo(entrada);
    this.ultimaHuella = huella;
    this.ultimoReporte = reporte;
    this.ejecucionesReales += 1;

    return {
      reporte,
      huella,
      desdeCache: false,
      estadisticasCache: {
        ejecucionesReales: this.ejecucionesReales,
        aciertosCache: this.aciertosCache,
      },
    };
  }

  invalidar(): void {
    this.ultimaHuella = null;
    this.ultimoReporte = null;
  }
}
