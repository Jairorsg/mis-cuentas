/**
 * Motor contable del núcleo financiero.
 *
 * REGLAS CONTABLES GARANTIZADAS:
 *  1. Montos siempre en céntimos enteros de PEN (MontoMinor). Cero punto flotante.
 *  2. Diferenciación explícita entre:
 *     - fechaMovimiento ("YYYY-MM-DD" en America/Lima) + horaMovimiento ("HH:mm")
 *     - registradoEn (instante UTC ISO-8601 real en que se creó el registro)
 *  3. Tipos de movimiento:
 *     - INGRESO        : incrementa ingresos del periodo y el saldo de la cuenta.
 *     - GASTO          : incrementa egresos del periodo y disminuye el saldo de la cuenta.
 *     - TRANSFERENCIA  : mueve fondos de cuentaId (origen) a cuentaDestinoId (destino).
 *                        NO incrementa ingresos ni gastos del periodo.
 *                        El pago de una tarjeta de crédito desde Efectivo/Yape/Plin/Débito
 *                        se registra como TRANSFERENCIA hacia la cuenta TARJETA_CREDITO,
 *                        evitando contabilizar dos veces los gastos ya realizados con la tarjeta.
 *     - SALDO_INICIAL  : establece el punto de partida real conocido de una cuenta.
 *                        NO incrementa ingresos ni gastos del periodo.
 *  4. Saldo bancario real vs. flujo acumulado:
 *     - Si una cuenta NO tiene un movimiento activo de tipo SALDO_INICIAL, el sistema
 *       NO calcula ni inventa un saldo bancario real (`saldoBancarioReal: null`,
 *       `estadoSaldo: 'SIN_SALDO_INICIAL'`). Solo informa el flujo neto de movimientos.
 *     - Si la cuenta tiene un SALDO_INICIAL activo, `saldoBancarioReal` es la suma exacta
 *       del saldo inicial + ingresos - gastos - transferencias salientes + transferencias entrantes.
 */
import { assertMontoEntero, type MontoMinor, sumarMontos } from './dinero';
import { ahoraISO, esFechaContableValida, fechaContableDe, mesDe } from './fechas';
import { esOrigenReal, historialInsuficiente, type OrigenReal, type ResultadoAnalitico } from './origen';

export const TIPOS_METODO_CUENTA = [
  'EFECTIVO',
  'YAPE',
  'PLIN',
  'TARJETA_DEBITO',
  'TARJETA_CREDITO',
  'CUENTA_BANCARIA',
  'AHORRO',
  'OTRO',
] as const;
export type TipoMetodoCuenta = (typeof TIPOS_METODO_CUENTA)[number];

export const TIPOS_MOVIMIENTO = ['INGRESO', 'GASTO', 'TRANSFERENCIA', 'SALDO_INICIAL'] as const;
export type TipoMovimiento = (typeof TIPOS_MOVIMIENTO)[number];

export const ESTADOS_REGISTRO = ['ACTIVO', 'ELIMINADO'] as const;
export type EstadoRegistro = (typeof ESTADOS_REGISTRO)[number];

export interface MetadatosAuditoria {
  origen: OrigenReal;
  creadoEn: string;
  actualizadoEn: string;
  eliminadoEn: string | null;
  version: number;
  loteImportacionId: string | null;
}

export interface CuentaMetodo {
  id: string;
  nombre: string;
  tipo: TipoMetodoCuenta;
  moneda: 'PEN';
  institucion: string | null;
  color: string | null;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export interface CategoriaPersonalizada {
  id: string;
  nombre: string;
  naturaleza: 'INGRESO' | 'GASTO';
  /** Si es null es categoría principal; si tiene valor es subcategoría de `padreId`. */
  padreId: string | null;
  icono: string | null;
  color: string | null;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export interface EventoFinanciero {
  id: string;
  nombre: string;
  descripcion: string | null;
  fechaInicio: string;
  fechaFin: string | null;
  presupuestoCentimos?: MontoMinor | null;
  presupuestoTotalCentimos?: MontoMinor;
  estadoEvento: 'PLANIFICADO' | 'ACTIVO' | 'FINALIZADO' | 'CANCELADO';
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export interface PresupuestoCategoria {
  id: string;
  periodoMes: string; // "YYYY-MM"
  categoriaId: string;
  limiteCentimos: MontoMinor;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

export interface MovimientoFinanciero {
  id: string;
  /** Fecha contable del hecho económico en America/Lima ("YYYY-MM-DD"). */
  fechaMovimiento: string;
  /** Hora del movimiento en America/Lima ("HH:mm"). */
  horaMovimiento: string;
  /** Instante exacto en que se registró en el sistema (ISO-8601 UTC). */
  registradoEn: string;
  tipo: TipoMovimiento;
  /** Categoría principal (obligatoria en INGRESO y GASTO; null en TRANSFERENCIA y SALDO_INICIAL). */
  categoriaId: string | null;
  /** Subcategoría opcional (hija de categoriaId). */
  subcategoriaId: string | null;
  /** Cuenta o método de pago origen (o la cuenta afectada en INGRESO/GASTO/SALDO_INICIAL). */
  cuentaId: string;
  /** Cuenta o método destino (obligatoria en TRANSFERENCIA, p. ej. al pagar tarjeta de crédito). */
  cuentaDestinoId: string | null;
  /** Monto positivo en céntimos de PEN (salvo en SALDO_INICIAL, que puede ser >= 0 o negativo para deuda inicial de TC). */
  montoCentimos: MontoMinor;
  moneda: 'PEN';
  /** Etiquetas normalizadas con '#' inicial (p. ej. ["#Rutina", "#ViajeTacna"]). */
  etiquetas: string[];
  descripcion: string | null;
  /** Evento asociado opcional (reutilizable e independiente). */
  eventoId: string | null;
  /** Indica si una transferencia corresponde al pago de una tarjeta de crédito (evita doble conteo). */
  esPagoTarjeta: boolean;
  estado: EstadoRegistro;
  auditoria: MetadatosAuditoria;
}

/** Catálogo opcional de métodos iniciales sugeridos (sin saldos ni movimientos). */
export const PLANTILLAS_METODOS_INICIALES: readonly {
  nombre: string;
  tipo: TipoMetodoCuenta;
  color: string;
}[] = Object.freeze([
  { nombre: 'Efectivo', tipo: 'EFECTIVO', color: '#16a34a' },
  { nombre: 'Yape', tipo: 'YAPE', color: '#7e22ce' },
  { nombre: 'Plin', tipo: 'PLIN', color: '#0284c7' },
  { nombre: 'Tarjeta de débito', tipo: 'TARJETA_DEBITO', color: '#2563eb' },
  { nombre: 'Tarjeta de crédito', tipo: 'TARJETA_CREDITO', color: '#dc2626' },
]);

/** Catálogo opcional de categorías iniciales sugeridas (no son datos financieros). */
export const PLANTILLAS_CATEGORIAS_INICIALES: readonly {
  nombre: string;
  naturaleza: 'INGRESO' | 'GASTO';
  subcategorias: readonly string[];
}[] = Object.freeze([
  {
    nombre: 'Alimentación',
    naturaleza: 'GASTO',
    subcategorias: ['Mercado y supermercado', 'Restaurantes y menú', 'Cafetería y snacks'],
  },
  {
    nombre: 'Transporte',
    naturaleza: 'GASTO',
    subcategorias: ['Pasajes y movilidad', 'Combustible', 'Mantenimiento'],
  },
  {
    nombre: 'Vivienda y servicios',
    naturaleza: 'GASTO',
    subcategorias: ['Alquiler / hipoteca', 'Luz y agua', 'Internet y telefonía'],
  },
  {
    nombre: 'Salud y bienestar',
    naturaleza: 'GASTO',
    subcategorias: ['Farmacia', 'Consultas médicas'],
  },
  {
    nombre: 'Ocio y eventos',
    naturaleza: 'GASTO',
    subcategorias: ['Viajes y salidas', 'Suscripciones'],
  },
  {
    nombre: 'Ingresos laborales',
    naturaleza: 'INGRESO',
    subcategorias: ['Sueldo', 'Honorarios / independiente', 'Bonificaciones'],
  },
  {
    nombre: 'Otros ingresos',
    naturaleza: 'INGRESO',
    subcategorias: ['Reembolsos', 'Intereses y rendimientos'],
  },
]);

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Normaliza etiquetas: asegura '#' al inicio, elimina vacías y duplicadas (insensible a mayúsculas). */
export function normalizarEtiquetas(etiquetas: readonly string[]): string[] {
  const vistas = new Set<string>();
  const resultado: string[] = [];
  for (const cruda of etiquetas) {
    const limpia = cruda.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!limpia) continue;
    const conHash = `#${limpia}`;
    const clave = conHash.toLowerCase();
    if (!vistas.has(clave)) {
      vistas.add(clave);
      resultado.push(conHash);
    }
  }
  return resultado;
}

/** Extrae etiquetas desde un texto separado por comas o espacios ("#Rutina, ViajeTacna"). */
export function parsearTextoEtiquetas(texto: string): string[] {
  if (!texto.trim()) return [];
  return normalizarEtiquetas(texto.split(/[\s,]+/));
}

export interface ContextoValidacionMovimiento {
  cuentas: ReadonlyMap<string, CuentaMetodo>;
  categorias: ReadonlyMap<string, CategoriaPersonalizada>;
  eventos: ReadonlyMap<string, EventoFinanciero>;
}

/** Valida todas las reglas de negocio y contables de un movimiento antes de persistirlo. */
export function validarMovimiento(mov: MovimientoFinanciero, ctx?: ContextoValidacionMovimiento): void {
  if (!mov.id.trim()) throw new Error('El identificador del movimiento es obligatorio');
  if (!esFechaContableValida(mov.fechaMovimiento)) {
    throw new Error(`Fecha del movimiento inválida: "${mov.fechaMovimiento}" (use YYYY-MM-DD)`);
  }
  if (!RE_HORA.test(mov.horaMovimiento)) {
    throw new Error(`Hora del movimiento inválida: "${mov.horaMovimiento}" (use HH:mm en 24h)`);
  }
  if (Number.isNaN(new Date(mov.registradoEn).getTime())) {
    throw new Error(`Fecha de registro inválida: "${mov.registradoEn}"`);
  }
  if (!esOrigenReal(mov.auditoria.origen)) {
    throw new Error(`Origen inválido: "${String(mov.auditoria.origen)}". Un dato proyectado o derivado no es una transacción.`);
  }
  assertMontoEntero(mov.montoCentimos, 'montoCentimos');
  if (mov.tipo !== 'SALDO_INICIAL' && mov.montoCentimos <= 0) {
    throw new Error('El monto del movimiento debe ser un entero positivo en céntimos de PEN');
  }
  if (!mov.cuentaId.trim()) throw new Error('Debe seleccionar una cuenta o método de pago');

  if (mov.tipo === 'TRANSFERENCIA') {
    if (!mov.cuentaDestinoId) {
      throw new Error('Una transferencia requiere cuenta de origen y cuenta de destino');
    }
    if (mov.cuentaDestinoId === mov.cuentaId) {
      throw new Error('La cuenta de origen y la de destino deben ser distintas');
    }
    if (mov.categoriaId !== null || mov.subcategoriaId !== null) {
      throw new Error('Las transferencias entre cuentas no llevan categoría de ingreso ni de gasto');
    }
  } else if (mov.tipo === 'SALDO_INICIAL') {
    if (mov.cuentaDestinoId !== null) {
      throw new Error('Un registro de saldo inicial no tiene cuenta de destino');
    }
    if (mov.categoriaId !== null || mov.subcategoriaId !== null) {
      throw new Error('Un saldo inicial no lleva categoría de ingreso ni de gasto');
    }
  } else {
    if (mov.cuentaDestinoId !== null) {
      throw new Error('Solo las transferencias tienen cuenta de destino');
    }
    if (!mov.categoriaId) {
      throw new Error('Los ingresos y egresos requieren una categoría');
    }
  }

  if (ctx) {
    const cuentaOrigen = ctx.cuentas.get(mov.cuentaId);
    if (!cuentaOrigen || cuentaOrigen.estado === 'ELIMINADO') {
      throw new Error('La cuenta seleccionada no existe o está eliminada');
    }
    if (mov.cuentaDestinoId) {
      const cuentaDestino = ctx.cuentas.get(mov.cuentaDestinoId);
      if (!cuentaDestino || cuentaDestino.estado === 'ELIMINADO') {
        throw new Error('La cuenta de destino no existe o está eliminada');
      }
    }
    if (mov.categoriaId) {
      const cat = ctx.categorias.get(mov.categoriaId);
      if (!cat || cat.estado === 'ELIMINADO') {
        throw new Error('La categoría seleccionada no existe o está eliminada');
      }
      if (cat.padreId !== null) {
        throw new Error('El campo categoriaId debe apuntar a una categoría principal, no a una subcategoría');
      }
      if ((mov.tipo === 'INGRESO' && cat.naturaleza !== 'INGRESO') || (mov.tipo === 'GASTO' && cat.naturaleza !== 'GASTO')) {
        throw new Error(`La categoría "${cat.nombre}" es de tipo ${cat.naturaleza} y no coincide con el movimiento (${mov.tipo})`);
      }
    }
    if (mov.subcategoriaId) {
      const sub = ctx.categorias.get(mov.subcategoriaId);
      if (!sub || sub.estado === 'ELIMINADO') {
        throw new Error('La subcategoría seleccionada no existe o está eliminada');
      }
      if (sub.padreId !== mov.categoriaId) {
        throw new Error('La subcategoría no pertenece a la categoría principal seleccionada');
      }
    }
    if (mov.eventoId) {
      const ev = ctx.eventos.get(mov.eventoId);
      if (!ev || ev.estado === 'ELIMINADO') {
        throw new Error('El evento asociado no existe o está eliminado');
      }
    }
  }
}

/**
 * Huella determinista para detectar duplicados en importaciones o registros repetidos.
 */
export function calcularHuellaMovimiento(p: {
  fechaMovimiento: string;
  tipo: TipoMovimiento;
  cuentaId: string;
  cuentaDestinoId?: string | null;
  montoCentimos: MontoMinor;
  descripcion?: string | null;
}): string {
  const desc = (p.descripcion ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [
    p.fechaMovimiento,
    p.tipo,
    p.cuentaId,
    p.cuentaDestinoId ?? '',
    String(p.montoCentimos),
    desc,
  ].join('|');
}

export interface SaldoCuentaCalculado {
  origen: 'DERIVADO';
  cuentaId: string;
  nombreCuenta: string;
  tipoCuenta: TipoMetodoCuenta;
  tieneSaldoInicial: boolean;
  saldoInicialCentimos: MontoMinor | null;
  fechaSaldoInicial: string | null;
  ingresosCentimos: MontoMinor;
  egresosCentimos: MontoMinor;
  transferenciasEntrantesCentimos: MontoMinor;
  transferenciasSalientesCentimos: MontoMinor;
  /** Flujo neto de movimientos registrados (sin contar saldo inicial). */
  flujoMovimientosCentimos: MontoMinor;
  /**
   * Saldo bancario real. Es `null` si el usuario aún no ha registrado el saldo
   * inicial real de esta cuenta (Regla 3: no calcular un saldo bancario real
   * si no existen los datos iniciales y movimientos necesarios).
   */
  saldoBancarioRealCentimos: MontoMinor | null;
  estadoSaldo: 'SALDO_REAL_COMPLETO' | 'SIN_SALDO_INICIAL' | 'MOVIMIENTOS_ANTERIORES_AL_SALDO_INICIAL';
  advertencia: string | null;
  cantidadMovimientos: number;
}

/** Calcula el estado de saldo de cada cuenta activa a partir de los movimientos activos. */
export function calcularSaldosPorCuenta(
  cuentas: readonly CuentaMetodo[],
  movimientos: readonly MovimientoFinanciero[],
): SaldoCuentaCalculado[] {
  const activas = cuentas.filter((c) => c.estado === 'ACTIVO');
  const movsActivos = movimientos.filter((m) => m.estado === 'ACTIVO');

  return activas.map((cuenta) => {
    let tieneSaldoInicial = false;
    let saldoInicial = 0;
    let fechaSaldoInicial: string | null = null;
    let hayMovimientosAntesDelSaldoInicial = false;

    const ingresos: MontoMinor[] = [];
    const egresos: MontoMinor[] = [];
    const entradasTransf: MontoMinor[] = [];
    const salidasTransf: MontoMinor[] = [];
    let cantidadMovimientos = 0;

    // Primero localizamos el saldo inicial más reciente si existe
    for (const m of movsActivos) {
      if (m.tipo === 'SALDO_INICIAL' && m.cuentaId === cuenta.id) {
        if (!tieneSaldoInicial || (fechaSaldoInicial !== null && m.fechaMovimiento >= fechaSaldoInicial)) {
          tieneSaldoInicial = true;
          saldoInicial = m.montoCentimos;
          fechaSaldoInicial = m.fechaMovimiento;
        }
      }
    }

    for (const m of movsActivos) {
      if (m.tipo === 'SALDO_INICIAL' && m.cuentaId === cuenta.id) {
        cantidadMovimientos++;
        continue;
      }
      const afectaOrigen = m.cuentaId === cuenta.id;
      const afectaDestino = m.tipo === 'TRANSFERENCIA' && m.cuentaDestinoId === cuenta.id;
      if (!afectaOrigen && !afectaDestino) continue;

      cantidadMovimientos++;
      if (fechaSaldoInicial !== null && m.fechaMovimiento < fechaSaldoInicial) {
        hayMovimientosAntesDelSaldoInicial = true;
      }

      if (m.tipo === 'INGRESO' && afectaOrigen) {
        ingresos.push(m.montoCentimos);
      } else if (m.tipo === 'GASTO' && afectaOrigen) {
        egresos.push(m.montoCentimos);
      } else if (m.tipo === 'TRANSFERENCIA') {
        if (afectaOrigen) salidasTransf.push(m.montoCentimos);
        if (afectaDestino) entradasTransf.push(m.montoCentimos);
      }
    }

    const totalIngresos = sumarMontos(ingresos);
    const totalEgresos = sumarMontos(egresos);
    const totalEntradas = sumarMontos(entradasTransf);
    const totalSalidas = sumarMontos(salidasTransf);
    const flujoMovimientos = sumarMontos([totalIngresos, -totalEgresos, totalEntradas, -totalSalidas]);

    if (!tieneSaldoInicial) {
      return {
        origen: 'DERIVADO',
        cuentaId: cuenta.id,
        nombreCuenta: cuenta.nombre,
        tipoCuenta: cuenta.tipo,
        tieneSaldoInicial: false,
        saldoInicialCentimos: null,
        fechaSaldoInicial: null,
        ingresosCentimos: totalIngresos,
        egresosCentimos: totalEgresos,
        transferenciasEntrantesCentimos: totalEntradas,
        transferenciasSalientesCentimos: totalSalidas,
        flujoMovimientosCentimos: flujoMovimientos,
        saldoBancarioRealCentimos: null,
        estadoSaldo: 'SIN_SALDO_INICIAL',
        advertencia:
          'Falta registrar el saldo inicial real de esta cuenta para mostrar su saldo bancario exacto.',
        cantidadMovimientos,
      };
    }

    if (hayMovimientosAntesDelSaldoInicial) {
      return {
        origen: 'DERIVADO',
        cuentaId: cuenta.id,
        nombreCuenta: cuenta.nombre,
        tipoCuenta: cuenta.tipo,
        tieneSaldoInicial: true,
        saldoInicialCentimos: saldoInicial,
        fechaSaldoInicial,
        ingresosCentimos: totalIngresos,
        egresosCentimos: totalEgresos,
        transferenciasEntrantesCentimos: totalEntradas,
        transferenciasSalientesCentimos: totalSalidas,
        flujoMovimientosCentimos: flujoMovimientos,
        saldoBancarioRealCentimos: null,
        estadoSaldo: 'MOVIMIENTOS_ANTERIORES_AL_SALDO_INICIAL',
        advertencia: `Existen movimientos con fecha anterior al saldo inicial (${fechaSaldoInicial}). Ajuste la fecha del saldo inicial para calcular el saldo bancario real.`,
        cantidadMovimientos,
      };
    }

    return {
      origen: 'DERIVADO',
      cuentaId: cuenta.id,
      nombreCuenta: cuenta.nombre,
      tipoCuenta: cuenta.tipo,
      tieneSaldoInicial: true,
      saldoInicialCentimos: saldoInicial,
      fechaSaldoInicial,
      ingresosCentimos: totalIngresos,
      egresosCentimos: totalEgresos,
      transferenciasEntrantesCentimos: totalEntradas,
      transferenciasSalientesCentimos: totalSalidas,
      flujoMovimientosCentimos: flujoMovimientos,
      saldoBancarioRealCentimos: sumarMontos([saldoInicial, flujoMovimientos]),
      estadoSaldo: 'SALDO_REAL_COMPLETO',
      advertencia: null,
      cantidadMovimientos,
    };
  });
}

export interface ItemDistribucionGasto {
  categoriaId: string;
  nombreCategoria: string;
  montoCentimos: MontoMinor;
  /** Porcentaje entero en centésimas (p. ej. 2550 = 25.50%) calculado sin float. */
  porcentajeBasisPoints: number;
  cantidadMovimientos: number;
}

export interface EstadoPresupuestoCalculado {
  presupuestoId: string;
  categoriaId: string;
  nombreCategoria: string;
  limiteCentimos: MontoMinor;
  gastadoCentimos: MontoMinor;
  disponibleCentimos: MontoMinor;
  porcentajeUsadoBasisPoints: number;
  excedido: boolean;
}

export interface ComparacionPeriodoAnterior {
  periodoAnterior: string;
  ingresosAnteriorCentimos: MontoMinor;
  egresosAnteriorCentimos: MontoMinor;
  flujoNetoAnteriorCentimos: MontoMinor;
  /** Variación en basis points (10000 = +100.00%), o null si el periodo anterior tuvo 0 en esa métrica. */
  variacionIngresosBp: number | null;
  variacionEgresosBp: number | null;
}

export interface ResumenDashboardPeriodo {
  origen: 'DERIVADO';
  periodoMes: string; // "YYYY-MM"
  ingresosPeriodoCentimos: MontoMinor;
  egresosPeriodoCentimos: MontoMinor;
  flujoNetoPeriodoCentimos: MontoMinor;
  transferenciasPeriodoCentimos: MontoMinor;
  pagosTarjetaPeriodoCentimos: MontoMinor;
  /** Suma de saldos bancarios reales únicamente de las cuentas que tienen saldo inicial verificado. */
  saldoRegistradoConocidoCentimos: MontoMinor | null;
  cuentasConSaldoReal: number;
  cuentasSinSaldoInicial: number;
  saldosPorCuenta: SaldoCuentaCalculado[];
  distribucionGastos: ResultadoAnalitico<ItemDistribucionGasto[]>;
  comparacionPeriodoAnterior: ResultadoAnalitico<ComparacionPeriodoAnterior>;
  estadoPresupuestos: EstadoPresupuestoCalculado[];
  ultimasTransacciones: MovimientoFinanciero[];
}

export function mesAnteriorDe(periodoMes: string): string {
  const [yStr, mStr] = periodoMes.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  if (m === 1) return `${String(y - 1).padStart(4, '0')}-12`;
  return `${String(y).padStart(4, '0')}-${String(m - 1).padStart(2, '0')}`;
}

function variacionBasisPoints(actual: MontoMinor, anterior: MontoMinor): number | null {
  if (anterior === 0) return null;
  return Number(((BigInt(actual - anterior) * 10000n) / BigInt(Math.abs(anterior))));
}

/**
 * Calcula todos los indicadores del Dashboard para un mes ("YYYY-MM")
 * exclusivamente desde los registros reales almacenados.
 */
export function calcularResumenPeriodo(params: {
  periodoMes: string;
  cuentas: readonly CuentaMetodo[];
  categorias: readonly CategoriaPersonalizada[];
  movimientos: readonly MovimientoFinanciero[];
  presupuestos: readonly PresupuestoCategoria[];
  limiteUltimas?: number;
}): ResumenDashboardPeriodo {
  const { periodoMes, cuentas, categorias, movimientos, presupuestos, limiteUltimas = 12 } = params;
  const mapaCategorias = new Map(categorias.map((c) => [c.id, c]));
  const movsActivos = movimientos.filter((m) => m.estado === 'ACTIVO');

  const delPeriodo = movsActivos.filter((m) => mesDe(m.fechaMovimiento) === periodoMes);
  const ingresosPeriodo = sumarMontos(
    delPeriodo.filter((m) => m.tipo === 'INGRESO').map((m) => m.montoCentimos),
  );
  const egresosPeriodo = sumarMontos(
    delPeriodo.filter((m) => m.tipo === 'GASTO').map((m) => m.montoCentimos),
  );
  const flujoNetoPeriodo = sumarMontos([ingresosPeriodo, -egresosPeriodo]);

  // Las transferencias NO se suman a ingresos ni a egresos (Regla 3).
  const transferenciasPeriodo = sumarMontos(
    delPeriodo.filter((m) => m.tipo === 'TRANSFERENCIA').map((m) => m.montoCentimos),
  );
  const pagosTarjetaPeriodo = sumarMontos(
    delPeriodo.filter((m) => m.tipo === 'TRANSFERENCIA' && m.esPagoTarjeta).map((m) => m.montoCentimos),
  );

  // Saldos por cuenta
  const saldosPorCuenta = calcularSaldosPorCuenta(cuentas, movsActivos);
  const conSaldoReal = saldosPorCuenta.filter((s) => s.saldoBancarioRealCentimos !== null);
  const sinSaldoInicial = saldosPorCuenta.length - conSaldoReal.length;
  const saldoRegistradoConocidoCentimos =
    conSaldoReal.length > 0
      ? sumarMontos(conSaldoReal.map((s) => s.saldoBancarioRealCentimos!))
      : null;

  // Distribución de gastos del periodo
  const gastosDelPeriodo = delPeriodo.filter((m) => m.tipo === 'GASTO');
  let distribucionGastos: ResultadoAnalitico<ItemDistribucionGasto[]>;
  if (gastosDelPeriodo.length === 0 || egresosPeriodo === 0) {
    distribucionGastos = historialInsuficiente(
      1,
      0,
      'egreso registrado en el periodo',
      `calcular la distribución de gastos de ${periodoMes}`,
    );
  } else {
    const porCat = new Map<string, { monto: MontoMinor[]; count: number }>();
    for (const g of gastosDelPeriodo) {
      const cid = g.categoriaId ?? 'sin_categoria';
      const actual = porCat.get(cid) ?? { monto: [], count: 0 };
      actual.monto.push(g.montoCentimos);
      actual.count += 1;
      porCat.set(cid, actual);
    }
    const items: ItemDistribucionGasto[] = [];
    for (const [categoriaId, info] of porCat.entries()) {
      const monto = sumarMontos(info.monto);
      const bp = Number((BigInt(monto) * 10000n) / BigInt(egresosPeriodo));
      items.push({
        categoriaId,
        nombreCategoria: mapaCategorias.get(categoriaId)?.nombre ?? 'Sin categoría',
        montoCentimos: monto,
        porcentajeBasisPoints: bp,
        cantidadMovimientos: info.count,
      });
    }
    items.sort((a, b) => b.montoCentimos - a.montoCentimos);
    distribucionGastos = {
      estado: 'OK',
      origen: 'DERIVADO',
      datos: items,
      ventana: {
        desde: `${periodoMes}-01`,
        hasta: `${periodoMes}-31`,
        observaciones: gastosDelPeriodo.length,
      },
    };
  }

  // Comparación con el periodo inmediatamente anterior (solo si existen movimientos de ingreso/gasto en él)
  const periodoAnterior = mesAnteriorDe(periodoMes);
  const movsAnterior = movsActivos.filter(
    (m) => mesDe(m.fechaMovimiento) === periodoAnterior && (m.tipo === 'INGRESO' || m.tipo === 'GASTO'),
  );
  let comparacionPeriodoAnterior: ResultadoAnalitico<ComparacionPeriodoAnterior>;
  if (movsAnterior.length === 0) {
    comparacionPeriodoAnterior = historialInsuficiente(
      1,
      0,
      `movimiento en ${periodoAnterior}`,
      `comparar ${periodoMes} con el periodo anterior (${periodoAnterior})`,
    );
  } else {
    const ingAnt = sumarMontos(movsAnterior.filter((m) => m.tipo === 'INGRESO').map((m) => m.montoCentimos));
    const egrAnt = sumarMontos(movsAnterior.filter((m) => m.tipo === 'GASTO').map((m) => m.montoCentimos));
    comparacionPeriodoAnterior = {
      estado: 'OK',
      origen: 'DERIVADO',
      datos: {
        periodoAnterior,
        ingresosAnteriorCentimos: ingAnt,
        egresosAnteriorCentimos: egrAnt,
        flujoNetoAnteriorCentimos: sumarMontos([ingAnt, -egrAnt]),
        variacionIngresosBp: variacionBasisPoints(ingresosPeriodo, ingAnt),
        variacionEgresosBp: variacionBasisPoints(egresosPeriodo, egrAnt),
      },
      ventana: {
        desde: `${periodoAnterior}-01`,
        hasta: `${periodoMes}-31`,
        observaciones: movsAnterior.length + delPeriodo.length,
      },
    };
  }

  // Presupuestos del periodo
  const presupuestosActivos = presupuestos.filter(
    (p) => p.estado === 'ACTIVO' && p.periodoMes === periodoMes,
  );
  const estadoPresupuestos: EstadoPresupuestoCalculado[] = presupuestosActivos.map((p) => {
    const gastado = sumarMontos(
      gastosDelPeriodo.filter((g) => g.categoriaId === p.categoriaId).map((g) => g.montoCentimos),
    );
    const disponible = sumarMontos([p.limiteCentimos, -gastado]);
    const bp = p.limiteCentimos > 0 ? Number((BigInt(gastado) * 10000n) / BigInt(p.limiteCentimos)) : 0;
    return {
      presupuestoId: p.id,
      categoriaId: p.categoriaId,
      nombreCategoria: mapaCategorias.get(p.categoriaId)?.nombre ?? 'Categoría',
      limiteCentimos: p.limiteCentimos,
      gastadoCentimos: gastado,
      disponibleCentimos: disponible,
      porcentajeUsadoBasisPoints: bp,
      excedido: gastado > p.limiteCentimos,
    };
  });

  // Últimas transacciones ordenadas por fechaMovimiento + horaMovimiento + registradoEn descendente
  const ultimasTransacciones = [...movsActivos]
    .sort((a, b) => {
      const fa = `${a.fechaMovimiento}T${a.horaMovimiento}`;
      const fb = `${b.fechaMovimiento}T${b.horaMovimiento}`;
      if (fa !== fb) return fa < fb ? 1 : -1;
      return a.registradoEn < b.registradoEn ? 1 : -1;
    })
    .slice(0, limiteUltimas);

  return {
    origen: 'DERIVADO',
    periodoMes,
    ingresosPeriodoCentimos: ingresosPeriodo,
    egresosPeriodoCentimos: egresosPeriodo,
    flujoNetoPeriodoCentimos: flujoNetoPeriodo,
    transferenciasPeriodoCentimos: transferenciasPeriodo,
    pagosTarjetaPeriodoCentimos: pagosTarjetaPeriodo,
    saldoRegistradoConocidoCentimos,
    cuentasConSaldoReal: conSaldoReal.length,
    cuentasSinSaldoInicial: sinSaldoInicial,
    saldosPorCuenta,
    distribucionGastos,
    comparacionPeriodoAnterior,
    estadoPresupuestos,
    ultimasTransacciones,
  };
}

/** Construye un movimiento nuevo con metadatos de auditoría consistentes. */
export function crearMovimientoNuevo(params: {
  id: string;
  fechaMovimiento?: string;
  horaMovimiento?: string;
  registradoEn?: string;
  tipo: TipoMovimiento;
  categoriaId?: string | null;
  subcategoriaId?: string | null;
  cuentaId: string;
  cuentaDestinoId?: string | null;
  montoCentimos: MontoMinor;
  etiquetas?: readonly string[];
  descripcion?: string | null;
  eventoId?: string | null;
  esPagoTarjeta?: boolean;
  origen?: OrigenReal;
  loteImportacionId?: string | null;
  ctx?: ContextoValidacionMovimiento;
}): MovimientoFinanciero {
  const ahora = params.registradoEn ?? ahoraISO();
  const mov: MovimientoFinanciero = {
    id: params.id,
    fechaMovimiento: params.fechaMovimiento ?? fechaContableDe(ahora),
    horaMovimiento: params.horaMovimiento ?? '12:00',
    registradoEn: ahora,
    tipo: params.tipo,
    categoriaId: params.tipo === 'INGRESO' || params.tipo === 'GASTO' ? (params.categoriaId ?? null) : null,
    subcategoriaId: params.tipo === 'INGRESO' || params.tipo === 'GASTO' ? (params.subcategoriaId ?? null) : null,
    cuentaId: params.cuentaId,
    cuentaDestinoId: params.tipo === 'TRANSFERENCIA' ? (params.cuentaDestinoId ?? null) : null,
    montoCentimos: params.montoCentimos,
    moneda: 'PEN',
    etiquetas: normalizarEtiquetas(params.etiquetas ?? []),
    descripcion: params.descripcion?.trim() ? params.descripcion.trim() : null,
    eventoId: params.eventoId ?? null,
    esPagoTarjeta: params.tipo === 'TRANSFERENCIA' ? Boolean(params.esPagoTarjeta) : false,
    estado: 'ACTIVO',
    auditoria: {
      origen: params.origen ?? 'MANUAL',
      creadoEn: ahora,
      actualizadoEn: ahora,
      eliminadoEn: null,
      version: 1,
      loteImportacionId: params.loteImportacionId ?? null,
    },
  };
  validarMovimiento(mov, params.ctx);
  return mov;
}
