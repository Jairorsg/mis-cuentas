/**
 * Capa de repositorios y puerto de almacenamiento desacoplado (Fase 1 + Fase 2).
 *
 * Extiende la fuente única de verdad sin crear un sistema paralelo:
 *  - Eventos universales con partidas presupuestarias y participantes.
 *  - Gastos planificados / comprometidos y su conversión atómica en transacción real.
 *  - Gastos compartidos, cuotas y liquidaciones parciales o totales.
 *  - Reglas de recurrencia (previsiones PROYECTADO) y su autorización explícita.
 */
import type {
  CategoriaPersonalizada,
  ConflictoSincronizacion,
  CuentaMetodo,
  CuotaParticipanteGasto,
  EstadoEventoUniversal,
  EstadoPlanificacionGasto,
  EstrategiaResolucionConflicto,
  EventoUniversal,
  FilaPrevisualizacionImportacion,
  FrecuenciaRecurrencia,
  GastoCompartido,
  GastoPlanificadoEvento,
  LiquidacionCompartida,
  MontoMinor,
  MovimientoFinanciero,
  OrigenReal,
  ParticipanteEvento,
  PartidaPresupuestoEvento,
  PresupuestoCategoria,
  ReglaRecurrencia,
  TipoMetodoCuenta,
  TipoMovimiento,
  TransporteNubeRls,
} from '@mis-cuentas/core';

export type EntidadSincronizable =
  | 'cuentas'
  | 'categorias'
  | 'eventos'
  | 'presupuestos'
  | 'transacciones'
  | 'gastos_planificados'
  | 'gastos_compartidos'
  | 'liquidaciones_compartidas'
  | 'reglas_recurrencia';

export interface CambioPendienteSincronizacion {
  id: string;
  entidad: EntidadSincronizable;
  registroId: string;
  operacion: 'UPSERT' | 'ELIMINACION_LOGICA';
  carga: unknown;
  creadoEn: string;
  intentos: number;
}

export interface PuertoSincronizacionSupabase {
  readonly nombreProveedor: 'supabase' | 'desconectado';
  estaConfigurado(): boolean;
  enviarCambiosPendientes(cambios: readonly CambioPendienteSincronizacion[]): Promise<{
    sincronizadosIds: string[];
    errores: { id: string; mensaje: string }[];
  }>;
  descargarCambiosDesde(ultimoCursorIso: string | null): Promise<{
    cursorNuevoIso: string;
    registros: { entidad: EntidadSincronizable; datos: unknown }[];
  }>;
}

export class AdaptadorSupabaseDesacoplado implements PuertoSincronizacionSupabase {
  readonly nombreProveedor = 'desconectado' as const;
  private readonly urlSupabase: string | null;
  private readonly anonKey: string | null;

  constructor(config?: { url?: string | null; anonKey?: string | null }) {
    this.urlSupabase = config?.url ?? null;
    this.anonKey = config?.anonKey ?? null;
  }

  estaConfigurado(): boolean {
    return Boolean(this.urlSupabase && this.anonKey);
  }

  async enviarCambiosPendientes(
    _cambios: readonly CambioPendienteSincronizacion[],
  ): Promise<{ sincronizadosIds: string[]; errores: { id: string; mensaje: string }[] }> {
    return { sincronizadosIds: [], errores: [] };
  }

  async descargarCambiosDesde(_ultimoCursorIso: string | null): Promise<{
    cursorNuevoIso: string;
    registros: { entidad: EntidadSincronizable; datos: unknown }[];
  }> {
    return { cursorNuevoIso: new Date().toISOString(), registros: [] };
  }
}

export interface EntradaCrearMovimiento {
  id?: string;
  fechaMovimiento?: string;
  horaMovimiento?: string;
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
}

export interface EntradaActualizarMovimiento {
  id: string;
  fechaMovimiento?: string;
  horaMovimiento?: string;
  tipo?: TipoMovimiento;
  categoriaId?: string | null;
  subcategoriaId?: string | null;
  cuentaId?: string;
  cuentaDestinoId?: string | null;
  montoCentimos?: MontoMinor;
  etiquetas?: readonly string[];
  descripcion?: string | null;
  eventoId?: string | null;
  esPagoTarjeta?: boolean;
}

export interface RegistroAuditoriaLocal {
  id: string;
  entidad: EntidadSincronizable;
  registroId: string;
  accion: 'CREACION' | 'MODIFICACION' | 'ELIMINACION_LOGICA' | 'RESTAURACION' | 'IMPORTACION';
  antes: unknown;
  despues: unknown;
  ocurridoEn: string;
}

export interface SesionCloudPersistida {
  uid: string;
  email: string;
  accessToken: string;
  refreshToken?: string | null;
  expiraEnEpochSegundos: number;
}

export interface VerificadorBloqueoPersistido {
  saltHex: string;
  hashHex: string;
  iteraciones: number;
}

export interface EstadoPersistenciaDispositivo {
  dispositivoId: string;
  ultimaSincronizacionIso: string | null;
  sesionCloud: SesionCloudPersistida | null;
  verificadorBloqueo: VerificadorBloqueoPersistido | null;
}

export interface EstadoInstantaneoRepositorio {
  versionEsquema: number;
  vacia: boolean;
  cuentas: CuentaMetodo[];
  categorias: CategoriaPersonalizada[];
  eventos: EventoUniversal[];
  presupuestos: PresupuestoCategoria[];
  movimientos: MovimientoFinanciero[];
  gastosPlanificados: GastoPlanificadoEvento[];
  gastosCompartidos: GastoCompartido[];
  liquidacionesCompartidas: LiquidacionCompartida[];
  reglasRecurrencia: ReglaRecurrencia[];
  cambiosPendientesSync: number;
  dispositivoId?: string;
  ultimaSincronizacionIso?: string | null;
  conflictosPendientes?: number;
}

export interface ResultadoEjecucionImportacion {
  loteId: string;
  insertados: number;
  sobrescritos: number;
  omitidosPorDuplicado: number;
}

export interface RepositorioFinanciero {
  inicializar(): Promise<void>;
  obtenerInstantanea(): Promise<EstadoInstantaneoRepositorio>;

  // Cuentas / métodos de pago
  crearCuenta(entrada: {
    id?: string;
    nombre: string;
    tipo: TipoMetodoCuenta;
    institucion?: string | null;
    color?: string | null;
    saldoInicialCentimos?: MontoMinor | null;
    fechaSaldoInicial?: string;
  }): Promise<CuentaMetodo>;
  activarMetodosInicialesSugeridos(): Promise<CuentaMetodo[]>;
  registrarOActualizarSaldoInicial(entrada: {
    cuentaId: string;
    saldoInicialCentimos: MontoMinor;
    fechaSaldoInicial: string;
  }): Promise<MovimientoFinanciero>;
  eliminarCuentaLogicamente(cuentaId: string): Promise<void>;

  // Categorías y subcategorías personalizadas
  crearCategoria(entrada: {
    id?: string;
    nombre: string;
    naturaleza: 'INGRESO' | 'GASTO';
    padreId?: string | null;
    color?: string | null;
    icono?: string | null;
  }): Promise<CategoriaPersonalizada>;
  activarCategoriasInicialesSugeridas(): Promise<CategoriaPersonalizada[]>;
  eliminarCategoriaLogicamente(categoriaId: string): Promise<void>;

  // Módulo 1 y 2: Eventos Universales y Presupuestos por Evento
  crearEvento(entrada: {
    id?: string;
    nombre: string;
    tipoEvento?: string;
    fechaInicio: string;
    fechaFin?: string | null;
    ubicacion?: string | null;
    presupuestoCentimos?: MontoMinor | null;
    presupuestoTotalCentimos?: MontoMinor;
    moneda?: string;
    partidasPresupuesto?: PartidaPresupuestoEvento[];
    participantes?: ParticipanteEvento[];
    etiquetas?: readonly string[];
    descripcion?: string | null;
    estadoEvento?: EstadoEventoUniversal;
    incluirPlantillaViaje?: boolean;
  }): Promise<EventoUniversal>;
  actualizarEvento(entrada: {
    id: string;
    nombre?: string;
    tipoEvento?: string;
    fechaInicio?: string;
    fechaFin?: string;
    ubicacion?: string | null;
    presupuestoTotalCentimos?: MontoMinor;
    moneda?: string;
    partidasPresupuesto?: PartidaPresupuestoEvento[];
    participantes?: ParticipanteEvento[];
    etiquetas?: readonly string[];
    descripcion?: string | null;
    estadoEvento?: EstadoEventoUniversal;
  }): Promise<EventoUniversal>;
  cambiarEstadoEvento(eventoId: string, estadoEvento: EstadoEventoUniversal): Promise<EventoUniversal>;
  eliminarEventoLogicamente(eventoId: string): Promise<void>;

  // Módulo 4: Planificación de gastos, actividades y compromisos
  crearGastoPlanificado(entrada: {
    id?: string;
    eventoId: string;
    partidaEventoId?: string | null;
    concepto: string;
    montoEstimadoCentimos: MontoMinor;
    fechaPrevista: string;
    estadoPlanificacion?: 'PLANIFICADO' | 'COMPROMETIDO';
    notas?: string | null;
  }): Promise<GastoPlanificadoEvento>;
  cambiarEstadoGastoPlanificado(
    gastoPlanificadoId: string,
    estadoPlanificacion: EstadoPlanificacionGasto,
  ): Promise<GastoPlanificadoEvento>;
  convertirGastoPlanificadoEnMovimientoReal(entrada: {
    gastoPlanificadoId: string;
    cuentaId: string;
    categoriaId: string;
    subcategoriaId?: string | null;
    montoRealCentimos?: MontoMinor;
    fechaMovimiento?: string;
    horaMovimiento?: string;
    etiquetas?: readonly string[];
  }): Promise<{ planificadoActualizado: GastoPlanificadoEvento; movimientoReal: MovimientoFinanciero }>;
  eliminarGastoPlanificadoLogicamente(gastoPlanificadoId: string): Promise<void>;

  // Módulo 5: Gastos compartidos, cuotas y liquidaciones
  registrarGastoCompartido(entrada: {
    id?: string;
    eventoId?: string | null;
    descripcion: string;
    fechaGasto: string;
    importeTotalCentimos: MontoMinor;
    pagadoPorParticipanteId: string;
    cuotas: CuotaParticipanteGasto[];
    registroEnMiCuenta?: {
      cuentaId: string;
      categoriaId: string;
      subcategoriaId?: string | null;
      etiquetas?: readonly string[];
    } | null;
  }): Promise<GastoCompartido>;
  registrarLiquidacionCompartida(entrada: {
    id?: string;
    eventoId?: string | null;
    gastoCompartidoId?: string | null;
    fechaLiquidacion: string;
    deudorParticipanteId: string;
    acreedorParticipanteId: string;
    montoCentimos: MontoMinor;
    nota?: string | null;
  }): Promise<LiquidacionCompartida>;
  eliminarGastoCompartidoLogicamente(gastoCompartidoId: string): Promise<void>;

  // Módulo 6: Reglas de recurrencia (previsiones PROYECTADO)
  crearReglaRecurrencia(entrada: {
    id?: string;
    nombre: string;
    tipo: 'GASTO' | 'INGRESO';
    montoEstimadoCentimos: MontoMinor;
    cuentaId: string;
    categoriaId: string;
    subcategoriaId?: string | null;
    eventoId?: string | null;
    frecuencia: FrecuenciaRecurrencia;
    intervaloDias?: number | null;
    fechaInicio: string;
    fechaFin?: string | null;
    etiquetas?: readonly string[];
  }): Promise<ReglaRecurrencia>;
  autorizarOcurrenciaRecurrente(entrada: {
    reglaId: string;
    fechaProgramada: string;
    montoRealCentimos?: MontoMinor;
    fechaMovimientoReal?: string;
  }): Promise<{ reglaActualizada: ReglaRecurrencia; movimientoReal: MovimientoFinanciero }>;
  eliminarReglaRecurrenciaLogicamente(reglaId: string): Promise<void>;

  // Presupuestos mensuales por categoría general
  guardarPresupuesto(entrada: {
    periodoMes: string;
    categoriaId: string;
    limiteCentimos: MontoMinor;
  }): Promise<PresupuestoCategoria>;
  eliminarPresupuestoLogicamente(presupuestoId: string): Promise<void>;

  // Movimientos reales
  registrarMovimiento(entrada: EntradaCrearMovimiento): Promise<MovimientoFinanciero>;
  editarMovimiento(entrada: EntradaActualizarMovimiento): Promise<MovimientoFinanciero>;
  eliminarMovimientoLogicamente(movimientoId: string): Promise<void>;
  restaurarMovimiento(movimientoId: string): Promise<void>;

  // Importación transaccional
  ejecutarImportacionTransaccional(params: {
    loteId: string;
    filasPrevisualizadas: readonly FilaPrevisualizacionImportacion[];
    politicaDuplicados: 'OMITIR' | 'SOBRESCRIBIR';
    cuentasIncluidas?: readonly CuentaMetodo[];
    categoriasIncluidas?: readonly CategoriaPersonalizada[];
    eventosIncluidos?: readonly unknown[];
    presupuestosIncluidos?: readonly PresupuestoCategoria[];
    gastosPlanificadosIncluidos?: readonly GastoPlanificadoEvento[];
    gastosCompartidosIncluidos?: readonly GastoCompartido[];
    liquidacionesCompartidasIncluidas?: readonly LiquidacionCompartida[];
    reglasRecurrenciaIncluidas?: readonly ReglaRecurrencia[];
  }): Promise<ResultadoEjecucionImportacion>;

  listarAuditoria(limite?: number): Promise<RegistroAuditoriaLocal[]>;
  listarCambiosPendientesSincronizacion(): Promise<CambioPendienteSincronizacion[]>;
  listarConflictosSincronizacion(): Promise<ConflictoSincronizacion[]>;
  sincronizarConTransporte(params: {
    transporte: TransporteNubeRls;
    propietarioId: string;
    dispositivoId: string;
  }): Promise<{
    enviados: number;
    recibidos: number;
    conflictosDetectados: number;
    ultimaSincronizacionIso: string;
  }>;
  resolverConflictoSincronizacion(params: {
    conflictoId: string;
    estrategia: EstrategiaResolucionConflicto;
    dispositivoId: string;
  }): Promise<void>;
  obtenerEstadoPersistenciaDispositivo?(): Promise<EstadoPersistenciaDispositivo>;
  guardarSesionCloudPersistente?(sesion: SesionCloudPersistida | null): Promise<void>;
  guardarVerificadorBloqueoLocal?(verificador: VerificadorBloqueoPersistido | null): Promise<void>;
  cerrar(): void;
}
