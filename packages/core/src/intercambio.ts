/**
 * Importación y exportación de información financiera (CSV y JSON).
 *
 * Cumple:
 *  - Validación de estructura y tipos de datos.
 *  - Previsualización de registros antes de persistir.
 *  - Detección de duplicados (por ID exacto y por huella contable).
 *  - Política explícita de duplicados: 'OMITIR' | 'SOBRESCRIBIR' (requiere confirmación del usuario).
 *  - Exportación completa en JSON y en CSV estándar RFC 4180.
 */
import { aTextoDecimal, parsearMonto } from './dinero';
import type { GastoCompartido, LiquidacionCompartida } from './compartidos';
import type { EventoUniversal, GastoPlanificadoEvento } from './eventos';
import { ahoraISO, esFechaContableValida } from './fechas';
import {
  calcularHuellaMovimiento,
  type CategoriaPersonalizada,
  type CuentaMetodo,
  type EventoFinanciero,
  type MovimientoFinanciero,
  normalizarEtiquetas,
  parsearTextoEtiquetas,
  type PresupuestoCategoria,
  TIPOS_MOVIMIENTO,
  type TipoMovimiento,
} from './libro';
import type { ReglaRecurrencia } from './recurrencia_calendario';

export interface PaqueteExportacionUsuario {
  formato: 'mis-cuentas/libro-usuario';
  version: 1;
  exportadoEn: string;
  monedaPrincipal: 'PEN';
  zonaHoraria: 'America/Lima';
  cuentas: CuentaMetodo[];
  categorias: CategoriaPersonalizada[];
  eventos: (EventoFinanciero | EventoUniversal)[];
  presupuestos: PresupuestoCategoria[];
  movimientos: MovimientoFinanciero[];
  gastosPlanificados?: GastoPlanificadoEvento[];
  gastosCompartidos?: GastoCompartido[];
  liquidacionesCompartidas?: LiquidacionCompartida[];
  reglasRecurrencia?: ReglaRecurrencia[];
}

export interface FilaPrevisualizacionImportacion {
  indiceFila: number;
  estado: 'NUEVO' | 'DUPLICADO_ID' | 'DUPLICADO_HUELLA' | 'ERROR';
  errores: string[];
  idExistenteCoincidente: string | null;
  movimientoPropuesto: MovimientoFinanciero | null;
  datosCrudos: Record<string, unknown>;
}

export interface ResultadoPrevisualizacionImportacion {
  formato: 'CSV' | 'JSON';
  totalFilas: number;
  validosNuevos: number;
  duplicadosDetectados: number;
  conErrores: number;
  filas: FilaPrevisualizacionImportacion[];
  cuentasIncluidas?: CuentaMetodo[];
  categoriasIncluidas?: CategoriaPersonalizada[];
  eventosIncluidos?: (EventoFinanciero | EventoUniversal)[];
  presupuestosIncluidos?: PresupuestoCategoria[];
  gastosPlanificadosIncluidos?: GastoPlanificadoEvento[];
  gastosCompartidosIncluidos?: GastoCompartido[];
  liquidacionesCompartidasIncluidas?: LiquidacionCompartida[];
  reglasRecurrenciaIncluidas?: ReglaRecurrencia[];
}

const CABECERAS_CSV = [
  'id',
  'fechaMovimiento',
  'horaMovimiento',
  'registradoEn',
  'tipo',
  'cuenta',
  'cuentaDestino',
  'categoria',
  'subcategoria',
  'montoPEN',
  'etiquetas',
  'descripcion',
  'evento',
  'esPagoTarjeta',
  'origen',
] as const;

function escaparCeldaCsv(valor: string): string {
  if (/[",\r\n]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

/** Exporta los movimientos activos a texto CSV (RFC 4180). */
export function exportarMovimientosACsv(params: {
  movimientos: readonly MovimientoFinanciero[];
  cuentas: readonly CuentaMetodo[];
  categorias: readonly CategoriaPersonalizada[];
  eventos: readonly EventoFinanciero[];
}): string {
  const mapaCuentas = new Map(params.cuentas.map((c) => [c.id, c.nombre]));
  const mapaCategorias = new Map(params.categorias.map((c) => [c.id, c.nombre]));
  const mapaEventos = new Map(params.eventos.map((e) => [e.id, e.nombre]));

  const lineas: string[] = [CABECERAS_CSV.join(',')];
  for (const m of params.movimientos.filter((x) => x.estado === 'ACTIVO')) {
    const fila = [
      m.id,
      m.fechaMovimiento,
      m.horaMovimiento,
      m.registradoEn,
      m.tipo,
      mapaCuentas.get(m.cuentaId) ?? m.cuentaId,
      m.cuentaDestinoId ? (mapaCuentas.get(m.cuentaDestinoId) ?? m.cuentaDestinoId) : '',
      m.categoriaId ? (mapaCategorias.get(m.categoriaId) ?? m.categoriaId) : '',
      m.subcategoriaId ? (mapaCategorias.get(m.subcategoriaId) ?? m.subcategoriaId) : '',
      aTextoDecimal(m.montoCentimos, 'PEN'),
      m.etiquetas.join(' '),
      m.descripcion ?? '',
      m.eventoId ? (mapaEventos.get(m.eventoId) ?? m.eventoId) : '',
      m.esPagoTarjeta ? 'true' : 'false',
      m.auditoria.origen,
    ];
    lineas.push(fila.map(escaparCeldaCsv).join(','));
  }
  return lineas.join('\n') + '\n';
}

/** Exporta toda la información financiera del usuario a JSON estructurado. */
export function exportarLibroAJson(params: {
  cuentas: readonly CuentaMetodo[];
  categorias: readonly CategoriaPersonalizada[];
  eventos: readonly (EventoFinanciero | EventoUniversal)[];
  presupuestos: readonly PresupuestoCategoria[];
  movimientos: readonly MovimientoFinanciero[];
  gastosPlanificados?: readonly GastoPlanificadoEvento[];
  gastosCompartidos?: readonly GastoCompartido[];
  liquidacionesCompartidas?: readonly LiquidacionCompartida[];
  reglasRecurrencia?: readonly ReglaRecurrencia[];
}): string {
  const paquete: PaqueteExportacionUsuario = {
    formato: 'mis-cuentas/libro-usuario',
    version: 1,
    exportadoEn: ahoraISO(),
    monedaPrincipal: 'PEN',
    zonaHoraria: 'America/Lima',
    cuentas: [...params.cuentas],
    categorias: [...params.categorias],
    eventos: [...params.eventos],
    presupuestos: [...params.presupuestos],
    movimientos: [...params.movimientos],
    gastosPlanificados: params.gastosPlanificados ? [...params.gastosPlanificados] : [],
    gastosCompartidos: params.gastosCompartidos ? [...params.gastosCompartidos] : [],
    liquidacionesCompartidas: params.liquidacionesCompartidas
      ? [...params.liquidacionesCompartidas]
      : [],
    reglasRecurrencia: params.reglasRecurrencia ? [...params.reglasRecurrencia] : [],
  };
  return JSON.stringify(paquete, null, 2);
}

/** Parser CSV conforme a RFC 4180 (soporta comillas escapadas y comas dentro de celdas). */
export function parsearLineasCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let filaActual: string[] = [];
  let celda = '';
  let enComillas = false;
  const limpio = texto.replace(/^\uFEFF/, '');

  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i]!;
    if (enComillas) {
      if (ch === '"') {
        if (limpio[i + 1] === '"') {
          celda += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        celda += ch;
      }
    } else if (ch === '"') {
      enComillas = true;
    } else if (ch === ',') {
      filaActual.push(celda.trim());
      celda = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && limpio[i + 1] === '\n') i++;
      filaActual.push(celda.trim());
      celda = '';
      if (filaActual.some((c) => c.length > 0)) {
        filas.push(filaActual);
      }
      filaActual = [];
    } else {
      celda += ch;
    }
  }
  if (celda.length > 0 || filaActual.length > 0) {
    filaActual.push(celda.trim());
    if (filaActual.some((c) => c.length > 0)) {
      filas.push(filaActual);
    }
  }
  return filas;
}

function resolverPorIdONombre<T extends { id: string; nombre: string; estado: string }>(
  coleccion: readonly T[],
  valor: string | undefined | null,
): T | null {
  if (!valor || !valor.trim()) return null;
  const limpio = valor.trim();
  const activas = coleccion.filter((x) => x.estado === 'ACTIVO');
  return (
    activas.find((x) => x.id === limpio) ??
    activas.find((x) => x.nombre.toLowerCase() === limpio.toLowerCase()) ??
    null
  );
}

/**
 * Analiza y previsualiza un archivo CSV antes de importarlo, detectando errores
 * de tipos/estructura y duplicados contra los movimientos existentes.
 */
export function previsualizarImportacionCsv(params: {
  contenidoCsv: string;
  cuentasExistentes: readonly CuentaMetodo[];
  categoriasExistentes: readonly CategoriaPersonalizada[];
  eventosExistentes: readonly EventoFinanciero[];
  movimientosExistentes: readonly MovimientoFinanciero[];
  loteImportacionId: string;
  generarId?: () => string;
}): ResultadoPrevisualizacionImportacion {
  const matriz = parsearLineasCsv(params.contenidoCsv);
  if (matriz.length < 2) {
    return {
      formato: 'CSV',
      totalFilas: 0,
      validosNuevos: 0,
      duplicadosDetectados: 0,
      conErrores: 1,
      filas: [
        {
          indiceFila: 1,
          estado: 'ERROR',
          errores: ['El archivo CSV debe incluir una fila de cabeceras y al menos una fila de datos'],
          idExistenteCoincidente: null,
          movimientoPropuesto: null,
          datosCrudos: {},
        },
      ],
    };
  }

  const cabeceras = matriz[0]!.map((h) => h.trim());
  const requeridas = ['fechaMovimiento', 'tipo', 'cuenta', 'montoPEN'];
  const faltantes = requeridas.filter((r) => !cabeceras.includes(r));
  if (faltantes.length > 0) {
    return {
      formato: 'CSV',
      totalFilas: 0,
      validosNuevos: 0,
      duplicadosDetectados: 0,
      conErrores: 1,
      filas: [
        {
          indiceFila: 1,
          estado: 'ERROR',
          errores: [`Faltan columnas obligatorias en el CSV: ${faltantes.join(', ')}`],
          idExistenteCoincidente: null,
          movimientoPropuesto: null,
          datosCrudos: { cabeceras },
        },
      ],
    };
  }

  const activosExistentes = params.movimientosExistentes.filter((m) => m.estado === 'ACTIVO');
  const porIdExistente = new Map(activosExistentes.map((m) => [m.id, m]));
  const porHuellaExistente = new Map(
    activosExistentes.map((m) => [
      calcularHuellaMovimiento({
        fechaMovimiento: m.fechaMovimiento,
        tipo: m.tipo,
        cuentaId: m.cuentaId,
        cuentaDestinoId: m.cuentaDestinoId,
        montoCentimos: m.montoCentimos,
        descripcion: m.descripcion,
      }),
      m,
    ]),
  );

  const filas: FilaPrevisualizacionImportacion[] = [];
  let validosNuevos = 0;
  let duplicadosDetectados = 0;
  let conErrores = 0;
  const ahora = ahoraISO();

  for (let idx = 1; idx < matriz.length; idx++) {
    const valores = matriz[idx]!;
    const crudo: Record<string, string> = {};
    cabeceras.forEach((col, cIdx) => {
      crudo[col] = valores[cIdx] ?? '';
    });

    const errores: string[] = [];
    const fechaMovimiento = crudo.fechaMovimiento ?? '';
    if (!esFechaContableValida(fechaMovimiento)) {
      errores.push(`Fecha inválida "${fechaMovimiento}" (use YYYY-MM-DD)`);
    }

    const horaMovimiento = crudo.horaMovimiento?.trim() || '12:00';
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(horaMovimiento)) {
      errores.push(`Hora inválida "${horaMovimiento}" (use HH:mm)`);
    }

    const tipoTexto = (crudo.tipo ?? '').trim().toUpperCase() as TipoMovimiento;
    if (!(TIPOS_MOVIMIENTO as readonly string[]).includes(tipoTexto)) {
      errores.push(`Tipo de movimiento inválido "${crudo.tipo ?? ''}" (use INGRESO, GASTO, TRANSFERENCIA o SALDO_INICIAL)`);
    }

    let montoCentimos = 0;
    try {
      montoCentimos = parsearMonto(crudo.montoPEN ?? '', 'PEN');
      if (tipoTexto !== 'SALDO_INICIAL' && montoCentimos <= 0) {
        errores.push('El monto en PEN debe ser mayor que cero');
      }
    } catch (e) {
      errores.push((e as Error).message);
    }

    const cuenta = resolverPorIdONombre(params.cuentasExistentes, crudo.cuenta);
    if (!cuenta) {
      errores.push(`Cuenta o método de pago no encontrado: "${crudo.cuenta ?? ''}"`);
    }

    let cuentaDestino: CuentaMetodo | null = null;
    if (tipoTexto === 'TRANSFERENCIA') {
      cuentaDestino = resolverPorIdONombre(params.cuentasExistentes, crudo.cuentaDestino);
      if (!cuentaDestino) {
        errores.push(`Cuenta destino no encontrada para transferencia: "${crudo.cuentaDestino ?? ''}"`);
      } else if (cuenta && cuentaDestino.id === cuenta.id) {
        errores.push('La cuenta origen y destino no pueden ser la misma');
      }
    }

    let categoria: CategoriaPersonalizada | null = null;
    let subcategoria: CategoriaPersonalizada | null = null;
    if (tipoTexto === 'INGRESO' || tipoTexto === 'GASTO') {
      const principales = params.categoriasExistentes.filter((c) => c.padreId === null);
      categoria = resolverPorIdONombre(principales, crudo.categoria);
      if (!categoria) {
        errores.push(`Categoría principal no encontrada: "${crudo.categoria ?? ''}"`);
      } else if (categoria.naturaleza !== tipoTexto) {
        errores.push(`La categoría "${categoria.nombre}" es de naturaleza ${categoria.naturaleza}, no ${tipoTexto}`);
      }
      if (crudo.subcategoria?.trim() && categoria) {
        const hijas = params.categoriasExistentes.filter((c) => c.padreId === categoria!.id);
        subcategoria = resolverPorIdONombre(hijas, crudo.subcategoria);
        if (!subcategoria) {
          errores.push(`Subcategoría "${crudo.subcategoria}" no pertenece a "${categoria.nombre}"`);
        }
      }
    }

    let evento: EventoFinanciero | null = null;
    if (crudo.evento?.trim()) {
      evento = resolverPorIdONombre(params.eventosExistentes, crudo.evento);
      if (!evento) {
        errores.push(`Evento no encontrado: "${crudo.evento}"`);
      }
    }

    if (errores.length > 0 || !cuenta) {
      conErrores++;
      filas.push({
        indiceFila: idx + 1,
        estado: 'ERROR',
        errores,
        idExistenteCoincidente: null,
        movimientoPropuesto: null,
        datosCrudos: crudo,
      });
      continue;
    }

    const idPropuesto =
      crudo.id?.trim() ||
      (params.generarId ? params.generarId() : `imp-${params.loteImportacionId}-${idx}`);
    const registradoEn =
      crudo.registradoEn && !Number.isNaN(new Date(crudo.registradoEn).getTime())
        ? new Date(crudo.registradoEn).toISOString()
        : ahora;

    const propuesto: MovimientoFinanciero = {
      id: idPropuesto,
      fechaMovimiento,
      horaMovimiento,
      registradoEn,
      tipo: tipoTexto,
      categoriaId: categoria?.id ?? null,
      subcategoriaId: subcategoria?.id ?? null,
      cuentaId: cuenta.id,
      cuentaDestinoId: cuentaDestino?.id ?? null,
      montoCentimos,
      moneda: 'PEN',
      etiquetas: parsearTextoEtiquetas(crudo.etiquetas ?? ''),
      descripcion: crudo.descripcion?.trim() ? crudo.descripcion.trim() : null,
      eventoId: evento?.id ?? null,
      esPagoTarjeta:
        tipoTexto === 'TRANSFERENCIA' &&
        (crudo.esPagoTarjeta === 'true' || cuentaDestino?.tipo === 'TARJETA_CREDITO'),
      estado: 'ACTIVO',
      auditoria: {
        origen: 'IMPORTADO',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: params.loteImportacionId,
      },
    };

    const huella = calcularHuellaMovimiento({
      fechaMovimiento: propuesto.fechaMovimiento,
      tipo: propuesto.tipo,
      cuentaId: propuesto.cuentaId,
      cuentaDestinoId: propuesto.cuentaDestinoId,
      montoCentimos: propuesto.montoCentimos,
      descripcion: propuesto.descripcion,
    });

    const dupId = porIdExistente.get(propuesto.id);
    const dupHuella = porHuellaExistente.get(huella);

    if (dupId) {
      duplicadosDetectados++;
      filas.push({
        indiceFila: idx + 1,
        estado: 'DUPLICADO_ID',
        errores: [],
        idExistenteCoincidente: dupId.id,
        movimientoPropuesto: propuesto,
        datosCrudos: crudo,
      });
    } else if (dupHuella) {
      duplicadosDetectados++;
      filas.push({
        indiceFila: idx + 1,
        estado: 'DUPLICADO_HUELLA',
        errores: [],
        idExistenteCoincidente: dupHuella.id,
        movimientoPropuesto: { ...propuesto, id: dupHuella.id },
        datosCrudos: crudo,
      });
    } else {
      validosNuevos++;
      filas.push({
        indiceFila: idx + 1,
        estado: 'NUEVO',
        errores: [],
        idExistenteCoincidente: null,
        movimientoPropuesto: propuesto,
        datosCrudos: crudo,
      });
    }
  }

  return {
    formato: 'CSV',
    totalFilas: filas.length,
    validosNuevos,
    duplicadosDetectados,
    conErrores,
    filas,
  };
}

/**
 * Analiza y previsualiza un paquete JSON antes de importarlo.
 */
export function previsualizarImportacionJson(params: {
  contenidoJson: string;
  movimientosExistentes: readonly MovimientoFinanciero[];
  loteImportacionId: string;
}): ResultadoPrevisualizacionImportacion {
  let obj: unknown;
  try {
    obj = JSON.parse(params.contenidoJson);
  } catch (e) {
    return {
      formato: 'JSON',
      totalFilas: 0,
      validosNuevos: 0,
      duplicadosDetectados: 0,
      conErrores: 1,
      filas: [
        {
          indiceFila: 1,
          estado: 'ERROR',
          errores: [`JSON mal formado: ${(e as Error).message}`],
          idExistenteCoincidente: null,
          movimientoPropuesto: null,
          datosCrudos: {},
        },
      ],
    };
  }

  if (
    typeof obj !== 'object' ||
    obj === null ||
    (obj as { formato?: string }).formato !== 'mis-cuentas/libro-usuario' ||
    !Array.isArray((obj as { movimientos?: unknown }).movimientos)
  ) {
    return {
      formato: 'JSON',
      totalFilas: 0,
      validosNuevos: 0,
      duplicadosDetectados: 0,
      conErrores: 1,
      filas: [
        {
          indiceFila: 1,
          estado: 'ERROR',
          errores: [
            'Estructura JSON inválida: se esperaba formato "mis-cuentas/libro-usuario" con arreglo "movimientos"',
          ],
          idExistenteCoincidente: null,
          movimientoPropuesto: null,
          datosCrudos: {},
        },
      ],
    };
  }

  const paquete = obj as PaqueteExportacionUsuario;
  const activosExistentes = params.movimientosExistentes.filter((m) => m.estado === 'ACTIVO');
  const porIdExistente = new Map(activosExistentes.map((m) => [m.id, m]));
  const porHuellaExistente = new Map(
    activosExistentes.map((m) => [
      calcularHuellaMovimiento({
        fechaMovimiento: m.fechaMovimiento,
        tipo: m.tipo,
        cuentaId: m.cuentaId,
        cuentaDestinoId: m.cuentaDestinoId,
        montoCentimos: m.montoCentimos,
        descripcion: m.descripcion,
      }),
      m,
    ]),
  );

  const filas: FilaPrevisualizacionImportacion[] = [];
  let validosNuevos = 0;
  let duplicadosDetectados = 0;
  let conErrores = 0;
  const ahora = ahoraISO();

  paquete.movimientos.forEach((crudo, i) => {
    const errores: string[] = [];
    if (typeof crudo?.id !== 'string' || !crudo.id.trim()) errores.push('Falta id');
    if (typeof crudo?.fechaMovimiento !== 'string' || !esFechaContableValida(crudo.fechaMovimiento)) {
      errores.push(`fechaMovimiento inválida: "${String(crudo?.fechaMovimiento)}"`);
    }
    if (!(TIPOS_MOVIMIENTO as readonly string[]).includes(String(crudo?.tipo))) {
      errores.push(`tipo inválido: "${String(crudo?.tipo)}"`);
    }
    if (typeof crudo?.montoCentimos !== 'number' || !Number.isSafeInteger(crudo.montoCentimos)) {
      errores.push('montoCentimos debe ser un entero en céntimos');
    } else if (crudo.tipo !== 'SALDO_INICIAL' && crudo.montoCentimos <= 0) {
      errores.push('montoCentimos debe ser positivo');
    }
    if (typeof crudo?.cuentaId !== 'string' || !crudo.cuentaId.trim()) {
      errores.push('Falta cuentaId');
    }

    if (errores.length > 0) {
      conErrores++;
      filas.push({
        indiceFila: i + 1,
        estado: 'ERROR',
        errores,
        idExistenteCoincidente: null,
        movimientoPropuesto: null,
        datosCrudos: (crudo as unknown as Record<string, unknown>) ?? {},
      });
      return;
    }

    const propuesto: MovimientoFinanciero = {
      ...crudo,
      moneda: 'PEN',
      horaMovimiento: crudo.horaMovimiento || '12:00',
      registradoEn: crudo.registradoEn || ahora,
      etiquetas: normalizarEtiquetas(Array.isArray(crudo.etiquetas) ? crudo.etiquetas : []),
      estado: crudo.estado === 'ELIMINADO' ? 'ELIMINADO' : 'ACTIVO',
      auditoria: {
        origen: 'IMPORTADO',
        creadoEn: crudo.auditoria?.creadoEn ?? ahora,
        actualizadoEn: ahora,
        eliminadoEn: crudo.auditoria?.eliminadoEn ?? null,
        version: (crudo.auditoria?.version ?? 1) + 1,
        loteImportacionId: params.loteImportacionId,
      },
    };

    const huella = calcularHuellaMovimiento({
      fechaMovimiento: propuesto.fechaMovimiento,
      tipo: propuesto.tipo,
      cuentaId: propuesto.cuentaId,
      cuentaDestinoId: propuesto.cuentaDestinoId,
      montoCentimos: propuesto.montoCentimos,
      descripcion: propuesto.descripcion,
    });

    const dupId = porIdExistente.get(propuesto.id);
    const dupHuella = porHuellaExistente.get(huella);

    if (dupId) {
      duplicadosDetectados++;
      filas.push({
        indiceFila: i + 1,
        estado: 'DUPLICADO_ID',
        errores: [],
        idExistenteCoincidente: dupId.id,
        movimientoPropuesto: propuesto,
        datosCrudos: crudo as unknown as Record<string, unknown>,
      });
    } else if (dupHuella) {
      duplicadosDetectados++;
      filas.push({
        indiceFila: i + 1,
        estado: 'DUPLICADO_HUELLA',
        errores: [],
        idExistenteCoincidente: dupHuella.id,
        movimientoPropuesto: { ...propuesto, id: dupHuella.id },
        datosCrudos: crudo as unknown as Record<string, unknown>,
      });
    } else {
      validosNuevos++;
      filas.push({
        indiceFila: i + 1,
        estado: 'NUEVO',
        errores: [],
        idExistenteCoincidente: null,
        movimientoPropuesto: propuesto,
        datosCrudos: crudo as unknown as Record<string, unknown>,
      });
    }
  });

  return {
    formato: 'JSON',
    totalFilas: filas.length,
    validosNuevos,
    duplicadosDetectados,
    conErrores,
    filas,
    cuentasIncluidas: Array.isArray(paquete.cuentas) ? paquete.cuentas : [],
    categoriasIncluidas: Array.isArray(paquete.categorias) ? paquete.categorias : [],
    eventosIncluidos: Array.isArray(paquete.eventos) ? paquete.eventos : [],
    presupuestosIncluidos: Array.isArray(paquete.presupuestos) ? paquete.presupuestos : [],
    gastosPlanificadosIncluidos: Array.isArray(paquete.gastosPlanificados)
      ? paquete.gastosPlanificados
      : [],
    gastosCompartidosIncluidos: Array.isArray(paquete.gastosCompartidos)
      ? paquete.gastosCompartidos
      : [],
    liquidacionesCompartidasIncluidas: Array.isArray(paquete.liquidacionesCompartidas)
      ? paquete.liquidacionesCompartidas
      : [],
    reglasRecurrenciaIncluidas: Array.isArray(paquete.reglasRecurrencia)
      ? paquete.reglasRecurrencia
      : [],
  };
}
