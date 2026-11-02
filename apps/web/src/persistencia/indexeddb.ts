/**
 * Implementación de `RepositorioFinanciero` sobre IndexedDB (Esquema v2).
 *
 * Migraciones versionadas:
 *  - v1: almacenes núcleo (`metadatos`, `cuentas`, `categorias`, `eventos`,
 *        `presupuestos`, `transacciones`, `auditoria`, `cola_sincronizacion`).
 *  - v2: almacenes Fase 2 (`gastos_planificados`, `gastos_compartidos`,
 *        `liquidaciones_compartidas`, `reglas_recurrencia`) integrados en la
 *        misma base de datos, manteniendo una sola fuente de verdad.
 */
import {
  ahoraISO,
  type CategoriaPersonalizada,
  type ConflictoSincronizacion,
  construirSobreResueltoDeConflicto,
  construirSobreSincronizacion,
  crearMovimientoNuevo,
  type CuentaMetodo,
  type CuotaParticipanteGasto,
  esFechaContableValida,
  type EstadoEventoUniversal,
  type EstadoPlanificacionGasto,
  type EstrategiaResolucionConflicto,
  evaluarCambioConcurrente,
  type EventoUniversal,
  type FilaPrevisualizacionImportacion,
  type FrecuenciaRecurrencia,
  type GastoCompartido,
  type GastoPlanificadoEvento,
  hoyLima,
  type LiquidacionCompartida,
  MONEDA_PRINCIPAL,
  type MontoMinor,
  type MovimientoFinanciero,
  type NombreEntidadSincronizable,
  normalizarEtiquetas,
  normalizarEventoUniversal,
  type ParticipanteEvento,
  type PartidaPresupuestoEvento,
  PLANTILLAS_CATEGORIAS_INICIALES,
  PLANTILLAS_METODOS_INICIALES,
  PLANTILLAS_PARTIDAS_VIAJE,
  type PresupuestoCategoria,
  type ReglaRecurrencia,
  type SobreSincronizacion,
  type TipoMetodoCuenta,
  type TransporteNubeRls,
  validarEventoUniversal,
  validarGastoCompartido,
  validarLiquidacionCompartida,
  validarMovimiento,
  validarReglaRecurrencia,
} from '@mis-cuentas/core';
import type {
  CambioPendienteSincronizacion,
  EntidadSincronizable,
  EntradaActualizarMovimiento,
  EntradaCrearMovimiento,
  EstadoInstantaneoRepositorio,
  EstadoPersistenciaDispositivo,
  PuertoSincronizacionSupabase,
  RegistroAuditoriaLocal,
  RepositorioFinanciero,
  ResultadoEjecucionImportacion,
  SesionCloudPersistida,
  VerificadorBloqueoPersistido,
} from './puerto';

export const VERSION_ESQUEMA_IDB = 2;

const ALMACENES = {
  METADATOS: 'metadatos',
  CUENTAS: 'cuentas',
  CATEGORIAS: 'categorias',
  EVENTOS: 'eventos',
  PRESUPUESTOS: 'presupuestos',
  TRANSACCIONES: 'transacciones',
  GASTOS_PLANIFICADOS: 'gastos_planificados',
  GASTOS_COMPARTIDOS: 'gastos_compartidos',
  LIQUIDACIONES: 'liquidaciones_compartidas',
  RECURRENCIA: 'reglas_recurrencia',
  AUDITORIA: 'auditoria',
  COLA_SYNC: 'cola_sincronizacion',
} as const;

function nuevoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function reqAPromesa<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Error en petición IndexedDB'));
  });
}

function txCompleta(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Transacción IndexedDB abortada'));
    tx.onerror = () => reject(tx.error ?? new Error('Error en transacción IndexedDB'));
  });
}

export class RepositorioIndexedDB implements RepositorioFinanciero {
  private db: IDBDatabase | null = null;
  private readonly nombreBd: string;
  private readonly fabricaIdb: IDBFactory;
  readonly puertoSync: PuertoSincronizacionSupabase | null;

  constructor(opciones?: {
    nombreBd?: string;
    indexedDB?: IDBFactory;
    puertoSync?: PuertoSincronizacionSupabase;
  }) {
    this.nombreBd = opciones?.nombreBd ?? 'mis_cuentas_permanente_v1';
    const idbGlobal = opciones?.indexedDB ?? globalThis.indexedDB;
    if (!idbGlobal) {
      throw new Error('IndexedDB no está disponible en este entorno');
    }
    this.fabricaIdb = idbGlobal;
    this.puertoSync = opciones?.puertoSync ?? null;
  }

  async inicializar(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.fabricaIdb.open(this.nombreBd, VERSION_ESQUEMA_IDB);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        const versionAnterior = ev.oldVersion;
        if (versionAnterior < 1) {
          db.createObjectStore(ALMACENES.METADATOS, { keyPath: 'clave' });

          const cuentas = db.createObjectStore(ALMACENES.CUENTAS, { keyPath: 'id' });
          cuentas.createIndex('por_estado', 'estado', { unique: false });

          const categorias = db.createObjectStore(ALMACENES.CATEGORIAS, { keyPath: 'id' });
          categorias.createIndex('por_naturaleza', 'naturaleza', { unique: false });
          categorias.createIndex('por_padre', 'padreId', { unique: false });

          const eventos = db.createObjectStore(ALMACENES.EVENTOS, { keyPath: 'id' });
          eventos.createIndex('por_estado_evento', 'estadoEvento', { unique: false });

          const presupuestos = db.createObjectStore(ALMACENES.PRESUPUESTOS, { keyPath: 'id' });
          presupuestos.createIndex('por_periodo', 'periodoMes', { unique: false });

          const txs = db.createObjectStore(ALMACENES.TRANSACCIONES, { keyPath: 'id' });
          txs.createIndex('por_fecha', 'fechaMovimiento', { unique: false });
          txs.createIndex('por_cuenta', 'cuentaId', { unique: false });
          txs.createIndex('por_evento', 'eventoId', { unique: false });

          const aud = db.createObjectStore(ALMACENES.AUDITORIA, { keyPath: 'id' });
          aud.createIndex('por_fecha', 'ocurridoEn', { unique: false });

          const sync = db.createObjectStore(ALMACENES.COLA_SYNC, { keyPath: 'id' });
          sync.createIndex('por_entidad', 'entidad', { unique: false });
        }
        if (versionAnterior < 2) {
          // Migración 0002: planificación por evento, gastos compartidos, liquidaciones y recurrencia
          const plan = db.createObjectStore(ALMACENES.GASTOS_PLANIFICADOS, { keyPath: 'id' });
          plan.createIndex('por_evento', 'eventoId', { unique: false });

          const comp = db.createObjectStore(ALMACENES.GASTOS_COMPARTIDOS, { keyPath: 'id' });
          comp.createIndex('por_evento', 'eventoId', { unique: false });

          const liq = db.createObjectStore(ALMACENES.LIQUIDACIONES, { keyPath: 'id' });
          liq.createIndex('por_evento', 'eventoId', { unique: false });

          const rec = db.createObjectStore(ALMACENES.RECURRENCIA, { keyPath: 'id' });
          rec.createIndex('por_frecuencia', 'frecuencia', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('No se pudo abrir IndexedDB'));
    });

    const tx = this.obtenerDb().transaction([ALMACENES.METADATOS], 'readwrite');
    const store = tx.objectStore(ALMACENES.METADATOS);
    store.put({ clave: 'version_esquema', valor: String(VERSION_ESQUEMA_IDB) });
    const [existente, dispExistente] = await Promise.all([
      reqAPromesa<{ clave: string; valor: string } | undefined>(store.get('creada_en')),
      reqAPromesa<{ clave: string; valor: string } | undefined>(store.get('dispositivo_id')),
    ]);
    if (!existente) {
      store.put({ clave: 'creada_en', valor: ahoraISO() });
      store.put({ clave: 'moneda_principal', valor: 'PEN' });
      store.put({ clave: 'zona_horaria', valor: 'America/Lima' });
    }
    if (!dispExistente?.valor) {
      const esMovil =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 1023px)').matches;
      const prefijo = esMovil ? 'celular-pwa' : 'dispositivo-pwa';
      store.put({
        clave: 'dispositivo_id',
        valor: `${prefijo}-${nuevoId().slice(0, 8)}`,
      });
    }
    await txCompleta(tx);

    // Solicitar almacenamiento persistente al navegador móvil para evitar expulsión de IndexedDB en viajes largos offline
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.persist === 'function'
      ) {
        await navigator.storage.persist();
      }
    } catch {
      // Ignorar si el entorno de pruebas o navegador no soporta StorageManager.persist
    }
  }

  private obtenerDb(): IDBDatabase {
    if (!this.db) throw new Error('El repositorio IndexedDB no ha sido inicializado. Llame a inicializar() primero.');
    return this.db;
  }

  private registrarAuditoriaYSyncEnTx(
    tx: IDBTransaction,
    params: {
      entidad: EntidadSincronizable;
      registroId: string;
      accion: RegistroAuditoriaLocal['accion'];
      operacionSync: CambioPendienteSincronizacion['operacion'];
      antes: unknown;
      despues: unknown;
      ahora: string;
    },
  ): void {
    const audStore = tx.objectStore(ALMACENES.AUDITORIA);
    const syncStore = tx.objectStore(ALMACENES.COLA_SYNC);
    const eventoAud: RegistroAuditoriaLocal = {
      id: nuevoId(),
      entidad: params.entidad,
      registroId: params.registroId,
      accion: params.accion,
      antes: params.antes,
      despues: params.despues,
      ocurridoEn: params.ahora,
    };
    audStore.put(eventoAud);

    const itemSync: CambioPendienteSincronizacion = {
      id: `${params.entidad}:${params.registroId}`,
      entidad: params.entidad,
      registroId: params.registroId,
      operacion: params.operacionSync,
      carga: params.despues,
      creadoEn: params.ahora,
      intentos: 0,
    };
    syncStore.put(itemSync);
  }

  async obtenerInstantanea(): Promise<EstadoInstantaneoRepositorio> {
    const db = this.obtenerDb();
    const tx = db.transaction(
      [
        ALMACENES.CUENTAS,
        ALMACENES.CATEGORIAS,
        ALMACENES.EVENTOS,
        ALMACENES.PRESUPUESTOS,
        ALMACENES.TRANSACCIONES,
        ALMACENES.GASTOS_PLANIFICADOS,
        ALMACENES.GASTOS_COMPARTIDOS,
        ALMACENES.LIQUIDACIONES,
        ALMACENES.RECURRENCIA,
        ALMACENES.COLA_SYNC,
        ALMACENES.METADATOS,
      ],
      'readonly',
    );
    const metaStore = tx.objectStore(ALMACENES.METADATOS);
    const [
      cuentas,
      categorias,
      eventosCrudos,
      presupuestos,
      movimientos,
      gastosPlanificados,
      gastosCompartidos,
      liquidacionesCompartidas,
      reglasRecurrencia,
      colaSync,
      metaDisp,
      metaUltimaSync,
      metaConflictos,
    ] = await Promise.all([
      reqAPromesa<CuentaMetodo[]>(tx.objectStore(ALMACENES.CUENTAS).getAll()),
      reqAPromesa<CategoriaPersonalizada[]>(tx.objectStore(ALMACENES.CATEGORIAS).getAll()),
      reqAPromesa<EventoUniversal[]>(tx.objectStore(ALMACENES.EVENTOS).getAll()),
      reqAPromesa<PresupuestoCategoria[]>(tx.objectStore(ALMACENES.PRESUPUESTOS).getAll()),
      reqAPromesa<MovimientoFinanciero[]>(tx.objectStore(ALMACENES.TRANSACCIONES).getAll()),
      reqAPromesa<GastoPlanificadoEvento[]>(tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).getAll()),
      reqAPromesa<GastoCompartido[]>(tx.objectStore(ALMACENES.GASTOS_COMPARTIDOS).getAll()),
      reqAPromesa<LiquidacionCompartida[]>(tx.objectStore(ALMACENES.LIQUIDACIONES).getAll()),
      reqAPromesa<ReglaRecurrencia[]>(tx.objectStore(ALMACENES.RECURRENCIA).getAll()),
      reqAPromesa<CambioPendienteSincronizacion[]>(tx.objectStore(ALMACENES.COLA_SYNC).getAll()),
      reqAPromesa<{ clave: string; valor: string } | undefined>(metaStore.get('dispositivo_id')),
      reqAPromesa<{ clave: string; valor: string } | undefined>(
        metaStore.get('ultima_sincronizacion_iso'),
      ),
      reqAPromesa<{ clave: string; valor: ConflictoSincronizacion[] } | undefined>(
        metaStore.get('conflictos_sincronizacion'),
      ),
    ]);

    const eventos = eventosCrudos.map((e) => normalizarEventoUniversal(e));

    const totalActivos =
      cuentas.filter((x) => x.estado === 'ACTIVO').length +
      categorias.filter((x) => x.estado === 'ACTIVO').length +
      eventos.filter((x) => x.estado === 'ACTIVO').length +
      presupuestos.filter((x) => x.estado === 'ACTIVO').length +
      movimientos.filter((x) => x.estado === 'ACTIVO').length +
      gastosPlanificados.filter((x) => x.estado === 'ACTIVO').length +
      gastosCompartidos.filter((x) => x.estado === 'ACTIVO').length +
      liquidacionesCompartidas.filter((x) => x.estado === 'ACTIVO').length +
      reglasRecurrencia.filter((x) => x.estado === 'ACTIVO').length;

    return {
      versionEsquema: VERSION_ESQUEMA_IDB,
      vacia: totalActivos === 0,
      cuentas,
      categorias,
      eventos,
      presupuestos,
      movimientos,
      gastosPlanificados,
      gastosCompartidos,
      liquidacionesCompartidas,
      reglasRecurrencia,
      cambiosPendientesSync: colaSync.length,
      dispositivoId: metaDisp?.valor ?? 'dispositivo-local',
      ultimaSincronizacionIso: metaUltimaSync?.valor ?? null,
      conflictosPendientes: (metaConflictos?.valor ?? []).length,
    };
  }

  async crearCuenta(entrada: {
    id?: string;
    nombre: string;
    tipo: TipoMetodoCuenta;
    institucion?: string | null;
    color?: string | null;
    saldoInicialCentimos?: MontoMinor | null;
    fechaSaldoInicial?: string;
  }): Promise<CuentaMetodo> {
    const nombreLimpio = entrada.nombre.trim();
    if (!nombreLimpio) throw new Error('El nombre de la cuenta o método de pago es obligatorio');

    const db = this.obtenerDb();
    const existentes = await reqAPromesa<CuentaMetodo[]>(
      db.transaction([ALMACENES.CUENTAS], 'readonly').objectStore(ALMACENES.CUENTAS).getAll(),
    );
    if (
      existentes.some(
        (c) => c.estado === 'ACTIVO' && c.nombre.toLowerCase() === nombreLimpio.toLowerCase(),
      )
    ) {
      throw new Error(`Ya existe una cuenta activa llamada "${nombreLimpio}"`);
    }

    const ahora = ahoraISO();
    const cuenta: CuentaMetodo = {
      id: entrada.id ?? nuevoId(),
      nombre: nombreLimpio,
      tipo: entrada.tipo,
      moneda: 'PEN',
      institucion: entrada.institucion?.trim() ? entrada.institucion.trim() : null,
      color: entrada.color ?? null,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };

    const tx = db.transaction(
      [ALMACENES.CUENTAS, ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.CUENTAS).put(cuenta);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'cuentas',
      registroId: cuenta.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: cuenta,
      ahora,
    });

    if (entrada.saldoInicialCentimos !== undefined && entrada.saldoInicialCentimos !== null) {
      const movSaldo = crearMovimientoNuevo({
        id: nuevoId(),
        fechaMovimiento: entrada.fechaSaldoInicial ?? hoyLima(),
        horaMovimiento: '00:00',
        registradoEn: ahora,
        tipo: 'SALDO_INICIAL',
        cuentaId: cuenta.id,
        montoCentimos: entrada.saldoInicialCentimos,
        descripcion: `Saldo inicial real de ${cuenta.nombre}`,
        origen: 'MANUAL',
      });
      tx.objectStore(ALMACENES.TRANSACCIONES).put(movSaldo);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'transacciones',
        registroId: movSaldo.id,
        accion: 'CREACION',
        operacionSync: 'UPSERT',
        antes: null,
        despues: movSaldo,
        ahora,
      });
    }

    await txCompleta(tx);
    return cuenta;
  }

  async activarMetodosInicialesSugeridos(): Promise<CuentaMetodo[]> {
    const inst = await this.obtenerInstantanea();
    const nombresActivos = new Set(
      inst.cuentas.filter((c) => c.estado === 'ACTIVO').map((c) => c.nombre.toLowerCase()),
    );
    const creadas: CuentaMetodo[] = [];
    for (const p of PLANTILLAS_METODOS_INICIALES) {
      if (!nombresActivos.has(p.nombre.toLowerCase())) {
        const c = await this.crearCuenta({
          nombre: p.nombre,
          tipo: p.tipo,
          color: p.color,
          saldoInicialCentimos: null,
        });
        creadas.push(c);
      }
    }
    return creadas;
  }

  async registrarOActualizarSaldoInicial(entrada: {
    cuentaId: string;
    saldoInicialCentimos: MontoMinor;
    fechaSaldoInicial: string;
  }): Promise<MovimientoFinanciero> {
    if (!esFechaContableValida(entrada.fechaSaldoInicial)) {
      throw new Error(`Fecha de saldo inicial inválida: "${entrada.fechaSaldoInicial}"`);
    }
    const inst = await this.obtenerInstantanea();
    const cuenta = inst.cuentas.find((c) => c.id === entrada.cuentaId && c.estado === 'ACTIVO');
    if (!cuenta) throw new Error('La cuenta no existe o está eliminada');

    const existente = inst.movimientos.find(
      (m) => m.estado === 'ACTIVO' && m.tipo === 'SALDO_INICIAL' && m.cuentaId === entrada.cuentaId,
    );

    const db = this.obtenerDb();
    const ahora = ahoraISO();
    const tx = db.transaction([ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');

    if (existente) {
      const actualizado: MovimientoFinanciero = {
        ...existente,
        fechaMovimiento: entrada.fechaSaldoInicial,
        montoCentimos: entrada.saldoInicialCentimos,
        auditoria: {
          ...existente.auditoria,
          actualizadoEn: ahora,
          version: existente.auditoria.version + 1,
        },
      };
      tx.objectStore(ALMACENES.TRANSACCIONES).put(actualizado);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'transacciones',
        registroId: actualizado.id,
        accion: 'MODIFICACION',
        operacionSync: 'UPSERT',
        antes: existente,
        despues: actualizado,
        ahora,
      });
      await txCompleta(tx);
      return actualizado;
    }

    const nuevo = crearMovimientoNuevo({
      id: nuevoId(),
      fechaMovimiento: entrada.fechaSaldoInicial,
      horaMovimiento: '00:00',
      registradoEn: ahora,
      tipo: 'SALDO_INICIAL',
      cuentaId: cuenta.id,
      montoCentimos: entrada.saldoInicialCentimos,
      descripcion: `Saldo inicial real de ${cuenta.nombre}`,
      origen: 'MANUAL',
    });
    tx.objectStore(ALMACENES.TRANSACCIONES).put(nuevo);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: nuevo.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: nuevo,
      ahora,
    });
    await txCompleta(tx);
    return nuevo;
  }

  async eliminarCuentaLogicamente(cuentaId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const cuenta = inst.cuentas.find((c) => c.id === cuentaId && c.estado === 'ACTIVO');
    if (!cuenta) throw new Error('La cuenta no existe o ya fue eliminada');
    const tieneMovs = inst.movimientos.some(
      (m) => m.estado === 'ACTIVO' && (m.cuentaId === cuentaId || m.cuentaDestinoId === cuentaId),
    );
    if (tieneMovs) {
      throw new Error('No se puede eliminar una cuenta que tiene movimientos activos registrados.');
    }
    const tieneReglas = inst.reglasRecurrencia.some(
      (r) => r.estado === 'ACTIVO' && r.cuentaId === cuentaId,
    );
    if (tieneReglas) {
      throw new Error('No se puede eliminar una cuenta asociada a reglas de recurrencia activas.');
    }

    const ahora = ahoraISO();
    const eliminada: CuentaMetodo = {
      ...cuenta,
      estado: 'ELIMINADO',
      auditoria: {
        ...cuenta.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: ahora,
        version: cuenta.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction([ALMACENES.CUENTAS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.CUENTAS).put(eliminada);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'cuentas',
      registroId: cuentaId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: cuenta,
      despues: eliminada,
      ahora,
    });
    await txCompleta(tx);
  }

  async crearCategoria(entrada: {
    id?: string;
    nombre: string;
    naturaleza: 'INGRESO' | 'GASTO';
    padreId?: string | null;
    color?: string | null;
    icono?: string | null;
  }): Promise<CategoriaPersonalizada> {
    const nombre = entrada.nombre.trim();
    if (!nombre) throw new Error('El nombre de la categoría es obligatorio');
    const inst = await this.obtenerInstantanea();
    const padreId = entrada.padreId ?? null;
    if (padreId) {
      const padre = inst.categorias.find((c) => c.id === padreId && c.estado === 'ACTIVO');
      if (!padre) throw new Error('La categoría principal seleccionada no existe');
      if (padre.padreId !== null) throw new Error('No se permiten más de dos niveles (categoría → subcategoría)');
      if (padre.naturaleza !== entrada.naturaleza) {
        throw new Error('La subcategoría debe tener la misma naturaleza que su categoría principal');
      }
    }
    const duplicada = inst.categorias.some(
      (c) =>
        c.estado === 'ACTIVO' &&
        c.padreId === padreId &&
        c.naturaleza === entrada.naturaleza &&
        c.nombre.toLowerCase() === nombre.toLowerCase(),
    );
    if (duplicada) throw new Error(`Ya existe la categoría "${nombre}"`);

    const ahora = ahoraISO();
    const cat: CategoriaPersonalizada = {
      id: entrada.id ?? nuevoId(),
      nombre,
      naturaleza: entrada.naturaleza,
      padreId,
      color: entrada.color ?? null,
      icono: entrada.icono ?? null,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    const tx = this.obtenerDb().transaction([ALMACENES.CATEGORIAS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.CATEGORIAS).put(cat);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'categorias',
      registroId: cat.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: cat,
      ahora,
    });
    await txCompleta(tx);
    return cat;
  }

  async activarCategoriasInicialesSugeridas(): Promise<CategoriaPersonalizada[]> {
    const inst = await this.obtenerInstantanea();
    const creadas: CategoriaPersonalizada[] = [];
    for (const grupo of PLANTILLAS_CATEGORIAS_INICIALES) {
      let principal = inst.categorias.find(
        (c) =>
          c.estado === 'ACTIVO' &&
          c.padreId === null &&
          c.naturaleza === grupo.naturaleza &&
          c.nombre.toLowerCase() === grupo.nombre.toLowerCase(),
      );
      if (!principal) {
        principal = await this.crearCategoria({
          nombre: grupo.nombre,
          naturaleza: grupo.naturaleza,
          padreId: null,
        });
        creadas.push(principal);
      }
      const actuales = await this.obtenerInstantanea();
      for (const subNombre of grupo.subcategorias) {
        const existeSub = actuales.categorias.some(
          (c) =>
            c.estado === 'ACTIVO' &&
            c.padreId === principal!.id &&
            c.nombre.toLowerCase() === subNombre.toLowerCase(),
        );
        if (!existeSub) {
          const sub = await this.crearCategoria({
            nombre: subNombre,
            naturaleza: grupo.naturaleza,
            padreId: principal.id,
          });
          creadas.push(sub);
        }
      }
    }
    return creadas;
  }

  async eliminarCategoriaLogicamente(categoriaId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const cat = inst.categorias.find((c) => c.id === categoriaId && c.estado === 'ACTIVO');
    if (!cat) throw new Error('La categoría no existe');
    const tieneHijasActivas = inst.categorias.some(
      (c) => c.estado === 'ACTIVO' && c.padreId === categoriaId,
    );
    if (tieneHijasActivas) {
      throw new Error(
        'No se puede eliminar una categoría principal que tiene subcategorías activas.',
      );
    }
    const tieneMovsActivos = inst.movimientos.some(
      (m) =>
        m.estado === 'ACTIVO' &&
        (m.categoriaId === categoriaId || m.subcategoriaId === categoriaId),
    );
    if (tieneMovsActivos) {
      throw new Error(
        'No se puede eliminar una categoría o subcategoría utilizada en movimientos activos.',
      );
    }
    const tienePresupuestosActivos = inst.presupuestos.some(
      (p) => p.estado === 'ACTIVO' && p.categoriaId === categoriaId,
    );
    if (tienePresupuestosActivos) {
      throw new Error(
        'No se puede eliminar una categoría que tiene presupuestos mensuales activos.',
      );
    }
    const tieneReglasActivas = inst.reglasRecurrencia.some(
      (r) =>
        r.estado === 'ACTIVO' &&
        (r.categoriaId === categoriaId || r.subcategoriaId === categoriaId),
    );
    if (tieneReglasActivas) {
      throw new Error(
        'No se puede eliminar una categoría asociada a reglas de recurrencia activas.',
      );
    }
    const ahora = ahoraISO();
    const eliminada: CategoriaPersonalizada = {
      ...cat,
      estado: 'ELIMINADO',
      auditoria: {
        ...cat.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: ahora,
        version: cat.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction([ALMACENES.CATEGORIAS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.CATEGORIAS).put(eliminada);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'categorias',
      registroId: categoriaId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: cat,
      despues: eliminada,
      ahora,
    });
    await txCompleta(tx);
  }

  // ───────────────────────── MÓDULO 1 y 2: EVENTOS UNIVERSALES ─────────────────────────
  async crearEvento(entrada: {
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
  }): Promise<EventoUniversal> {
    const nombre = entrada.nombre.trim();
    if (!nombre) throw new Error('El nombre del evento es obligatorio');
    const tipoEvento = entrada.tipoEvento?.trim() || 'VIAJE';
    const fechaFin = entrada.fechaFin?.trim() ? entrada.fechaFin.trim() : entrada.fechaInicio;
    const presupuestoTotal =
      entrada.presupuestoTotalCentimos !== undefined
        ? entrada.presupuestoTotalCentimos
        : (entrada.presupuestoCentimos ?? 0);

    let partidas = entrada.partidasPresupuesto ? [...entrada.partidasPresupuesto] : [];
    if (
      partidas.length === 0 &&
      (entrada.incluirPlantillaViaje || tipoEvento.toUpperCase() === 'VIAJE')
    ) {
      partidas = PLANTILLAS_PARTIDAS_VIAJE.map((p, idx) => ({
        id: `part-${idx + 1}-${Math.random().toString(36).slice(2, 7)}`,
        nombre: p.nombre,
        asignadoCentimos: 0,
      }));
    }

    const participantes =
      entrada.participantes && entrada.participantes.length > 0
        ? [...entrada.participantes]
        : [{ id: 'yo', nombre: 'Yo', esUsuarioTitular: true }];

    const ahora = ahoraISO();
    const ev: EventoUniversal = {
      id: entrada.id ?? nuevoId(),
      nombre,
      tipoEvento,
      fechaInicio: entrada.fechaInicio,
      fechaFin,
      ubicacion: entrada.ubicacion?.trim() ? entrada.ubicacion.trim() : null,
      presupuestoTotalCentimos: presupuestoTotal,
      moneda: entrada.moneda ?? MONEDA_PRINCIPAL,
      partidasPresupuesto: partidas,
      participantes,
      etiquetas: normalizarEtiquetas(entrada.etiquetas ?? []),
      descripcion: entrada.descripcion?.trim() ? entrada.descripcion.trim() : null,
      estadoEvento: entrada.estadoEvento ?? 'ACTIVO',
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    validarEventoUniversal(ev);

    const tx = this.obtenerDb().transaction([ALMACENES.EVENTOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.EVENTOS).put(ev);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'eventos',
      registroId: ev.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: ev,
      ahora,
    });
    await txCompleta(tx);
    return ev;
  }

  async actualizarEvento(entrada: {
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
  }): Promise<EventoUniversal> {
    const inst = await this.obtenerInstantanea();
    const ev = inst.eventos.find((e) => e.id === entrada.id && e.estado === 'ACTIVO');
    if (!ev) throw new Error('El evento no existe o fue eliminado');

    const ahora = ahoraISO();
    const actualizado: EventoUniversal = {
      ...ev,
      nombre: entrada.nombre !== undefined ? entrada.nombre.trim() : ev.nombre,
      tipoEvento: entrada.tipoEvento !== undefined ? entrada.tipoEvento.trim() : ev.tipoEvento,
      fechaInicio: entrada.fechaInicio ?? ev.fechaInicio,
      fechaFin: entrada.fechaFin ?? ev.fechaFin,
      ubicacion:
        entrada.ubicacion !== undefined
          ? entrada.ubicacion?.trim()
            ? entrada.ubicacion.trim()
            : null
          : ev.ubicacion,
      presupuestoTotalCentimos:
        entrada.presupuestoTotalCentimos !== undefined
          ? entrada.presupuestoTotalCentimos
          : ev.presupuestoTotalCentimos,
      moneda: entrada.moneda ?? ev.moneda,
      partidasPresupuesto:
        entrada.partidasPresupuesto !== undefined
          ? [...entrada.partidasPresupuesto]
          : ev.partidasPresupuesto,
      participantes:
        entrada.participantes !== undefined ? [...entrada.participantes] : ev.participantes,
      etiquetas:
        entrada.etiquetas !== undefined ? normalizarEtiquetas(entrada.etiquetas) : ev.etiquetas,
      descripcion:
        entrada.descripcion !== undefined
          ? entrada.descripcion?.trim()
            ? entrada.descripcion.trim()
            : null
          : ev.descripcion,
      estadoEvento: entrada.estadoEvento ?? ev.estadoEvento,
      auditoria: {
        ...ev.auditoria,
        actualizadoEn: ahora,
        version: ev.auditoria.version + 1,
      },
    };
    validarEventoUniversal(actualizado);

    const tx = this.obtenerDb().transaction([ALMACENES.EVENTOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.EVENTOS).put(actualizado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'eventos',
      registroId: actualizado.id,
      accion: 'MODIFICACION',
      operacionSync: 'UPSERT',
      antes: ev,
      despues: actualizado,
      ahora,
    });
    await txCompleta(tx);
    return actualizado;
  }

  async cambiarEstadoEvento(eventoId: string, estadoEvento: EstadoEventoUniversal): Promise<EventoUniversal> {
    return this.actualizarEvento({ id: eventoId, estadoEvento });
  }

  async eliminarEventoLogicamente(eventoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const ev = inst.eventos.find((e) => e.id === eventoId && e.estado === 'ACTIVO');
    if (!ev) throw new Error('El evento no existe');
    const tieneMovs = inst.movimientos.some(
      (m) => m.estado === 'ACTIVO' && m.eventoId === eventoId,
    );
    if (tieneMovs) {
      throw new Error(
        'No se puede eliminar un evento que tiene movimientos activos vinculados.',
      );
    }
    const tienePlanificados = inst.gastosPlanificados.some(
      (gp) => gp.estado === 'ACTIVO' && gp.eventoId === eventoId,
    );
    if (tienePlanificados) {
      throw new Error(
        'No se puede eliminar un evento que tiene gastos planificados o comprometidos activos.',
      );
    }
    const tieneCompartidos = inst.gastosCompartidos.some(
      (gc) => gc.estado === 'ACTIVO' && gc.eventoId === eventoId,
    );
    if (tieneCompartidos) {
      throw new Error(
        'No se puede eliminar un evento que tiene gastos compartidos activos.',
      );
    }
    const ahora = ahoraISO();
    const eliminado: EventoUniversal = {
      ...ev,
      estado: 'ELIMINADO',
      auditoria: {
        ...ev.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: ahora,
        version: ev.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction([ALMACENES.EVENTOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.EVENTOS).put(eliminado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'eventos',
      registroId: eventoId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: ev,
      despues: eliminado,
      ahora,
    });
    await txCompleta(tx);
  }

  // ───────────────────────── MÓDULO 4: PLANIFICACIÓN DE GASTOS ─────────────────────────
  async crearGastoPlanificado(entrada: {
    id?: string;
    eventoId: string;
    partidaEventoId?: string | null;
    concepto: string;
    montoEstimadoCentimos: MontoMinor;
    fechaPrevista: string;
    estadoPlanificacion?: 'PLANIFICADO' | 'COMPROMETIDO';
    notas?: string | null;
  }): Promise<GastoPlanificadoEvento> {
    if (!entrada.concepto.trim()) throw new Error('El concepto del gasto planificado es obligatorio');
    if (entrada.montoEstimadoCentimos <= 0) {
      throw new Error('El monto estimado debe ser mayor que cero');
    }
    if (!esFechaContableValida(entrada.fechaPrevista)) {
      throw new Error(`Fecha prevista inválida: "${entrada.fechaPrevista}"`);
    }
    const inst = await this.obtenerInstantanea();
    const ev = inst.eventos.find((e) => e.id === entrada.eventoId && e.estado === 'ACTIVO');
    if (!ev) throw new Error('El evento asociado no existe');

    const ahora = ahoraISO();
    const item: GastoPlanificadoEvento = {
      id: entrada.id ?? nuevoId(),
      eventoId: entrada.eventoId,
      partidaEventoId: entrada.partidaEventoId ?? null,
      concepto: entrada.concepto.trim(),
      montoEstimadoCentimos: entrada.montoEstimadoCentimos,
      fechaPrevista: entrada.fechaPrevista,
      estadoPlanificacion: entrada.estadoPlanificacion ?? 'PLANIFICADO',
      movimientoRealId: null,
      notas: entrada.notas?.trim() ? entrada.notas.trim() : null,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };

    const tx = this.obtenerDb().transaction(
      [ALMACENES.GASTOS_PLANIFICADOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).put(item);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_planificados',
      registroId: item.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: item,
      ahora,
    });
    await txCompleta(tx);
    return item;
  }

  async cambiarEstadoGastoPlanificado(
    gastoPlanificadoId: string,
    estadoPlanificacion: EstadoPlanificacionGasto,
  ): Promise<GastoPlanificadoEvento> {
    const inst = await this.obtenerInstantanea();
    const existente = inst.gastosPlanificados.find(
      (g) => g.id === gastoPlanificadoId && g.estado === 'ACTIVO',
    );
    if (!existente) throw new Error('Gasto planificado no encontrado');
    const ahora = ahoraISO();
    const actualizado: GastoPlanificadoEvento = {
      ...existente,
      estadoPlanificacion,
      auditoria: {
        ...existente.auditoria,
        actualizadoEn: ahora,
        version: existente.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction(
      [ALMACENES.GASTOS_PLANIFICADOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).put(actualizado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_planificados',
      registroId: actualizado.id,
      accion: 'MODIFICACION',
      operacionSync: 'UPSERT',
      antes: existente,
      despues: actualizado,
      ahora,
    });
    await txCompleta(tx);
    return actualizado;
  }

  async convertirGastoPlanificadoEnMovimientoReal(entrada: {
    gastoPlanificadoId: string;
    cuentaId: string;
    categoriaId: string;
    subcategoriaId?: string | null;
    montoRealCentimos?: MontoMinor;
    fechaMovimiento?: string;
    horaMovimiento?: string;
    etiquetas?: readonly string[];
  }): Promise<{ planificadoActualizado: GastoPlanificadoEvento; movimientoReal: MovimientoFinanciero }> {
    const inst = await this.obtenerInstantanea();
    const plan = inst.gastosPlanificados.find(
      (g) => g.id === entrada.gastoPlanificadoId && g.estado === 'ACTIVO',
    );
    if (!plan) throw new Error('El gasto planificado no existe o fue eliminado');
    if (plan.estadoPlanificacion === 'REGISTRADO' && plan.movimientoRealId) {
      const movYaExiste = inst.movimientos.some(
        (m) => m.id === plan.movimientoRealId && m.estado === 'ACTIVO',
      );
      if (movYaExiste) {
        throw new Error(
          'Este gasto planificado ya fue convertido en una transacción real activa (se impide duplicar el importe).',
        );
      }
    }

    const ctx = {
      cuentas: new Map(inst.cuentas.map((c) => [c.id, c])),
      categorias: new Map(inst.categorias.map((c) => [c.id, c])),
      eventos: new Map(
        inst.eventos.map((e) => [
          e.id,
          {
            ...e,
            presupuestoCentimos: e.presupuestoTotalCentimos,
            estadoEvento: e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
          },
        ]),
      ),
    };

    const ahora = ahoraISO();
    const movReal = crearMovimientoNuevo({
      id: nuevoId(),
      fechaMovimiento: entrada.fechaMovimiento ?? plan.fechaPrevista,
      horaMovimiento: entrada.horaMovimiento ?? '12:00',
      registradoEn: ahora,
      tipo: 'GASTO',
      cuentaId: entrada.cuentaId,
      categoriaId: entrada.categoriaId,
      subcategoriaId: entrada.subcategoriaId ?? null,
      montoCentimos: entrada.montoRealCentimos ?? plan.montoEstimadoCentimos,
      descripcion: plan.concepto,
      eventoId: plan.eventoId,
      etiquetas: entrada.etiquetas ?? [],
      origen: 'MANUAL',
      ctx,
    });

    const planActualizado: GastoPlanificadoEvento = {
      ...plan,
      estadoPlanificacion: 'REGISTRADO',
      movimientoRealId: movReal.id,
      auditoria: {
        ...plan.auditoria,
        actualizadoEn: ahora,
        version: plan.auditoria.version + 1,
      },
    };

    const tx = this.obtenerDb().transaction(
      [
        ALMACENES.TRANSACCIONES,
        ALMACENES.GASTOS_PLANIFICADOS,
        ALMACENES.AUDITORIA,
        ALMACENES.COLA_SYNC,
      ],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(movReal);
    tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).put(planActualizado);

    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: movReal.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: movReal,
      ahora,
    });
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_planificados',
      registroId: planActualizado.id,
      accion: 'MODIFICACION',
      operacionSync: 'UPSERT',
      antes: plan,
      despues: planActualizado,
      ahora,
    });

    await txCompleta(tx);
    return { planificadoActualizado: planActualizado, movimientoReal: movReal };
  }

  async eliminarGastoPlanificadoLogicamente(gastoPlanificadoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const existente = inst.gastosPlanificados.find(
      (g) => g.id === gastoPlanificadoId && g.estado === 'ACTIVO',
    );
    if (!existente) throw new Error('Gasto planificado no encontrado');
    const ahora = ahoraISO();
    const eliminado: GastoPlanificadoEvento = {
      ...existente,
      estado: 'ELIMINADO',
      auditoria: {
        ...existente.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: ahora,
        version: existente.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction(
      [ALMACENES.GASTOS_PLANIFICADOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).put(eliminado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_planificados',
      registroId: gastoPlanificadoId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: existente,
      despues: eliminado,
      ahora,
    });
    await txCompleta(tx);
  }

  // ───────────────────────── MÓDULO 5: GASTOS COMPARTIDOS Y LIQUIDACIONES ─────────────────────────
  async registrarGastoCompartido(entrada: {
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
  }): Promise<GastoCompartido> {
    const ahora = ahoraISO();
    let movReal: MovimientoFinanciero | null = null;

    if (entrada.registroEnMiCuenta) {
      const inst = await this.obtenerInstantanea();
      const ctx = {
        cuentas: new Map(inst.cuentas.map((c) => [c.id, c])),
        categorias: new Map(inst.categorias.map((c) => [c.id, c])),
        eventos: new Map(
          inst.eventos.map((e) => [
            e.id,
            {
              ...e,
              presupuestoCentimos: e.presupuestoTotalCentimos,
              estadoEvento:
                e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
            },
          ]),
        ),
      };
      movReal = crearMovimientoNuevo({
        id: nuevoId(),
        fechaMovimiento: entrada.fechaGasto,
        horaMovimiento: '12:00',
        registradoEn: ahora,
        tipo: 'GASTO',
        cuentaId: entrada.registroEnMiCuenta.cuentaId,
        categoriaId: entrada.registroEnMiCuenta.categoriaId,
        subcategoriaId: entrada.registroEnMiCuenta.subcategoriaId ?? null,
        montoCentimos: entrada.importeTotalCentimos,
        descripcion: entrada.descripcion.trim(),
        eventoId: entrada.eventoId ?? null,
        etiquetas: entrada.registroEnMiCuenta.etiquetas ?? ['#Compartido'],
        origen: 'MANUAL',
        ctx,
      });
    }

    const compartido: GastoCompartido = {
      id: entrada.id ?? nuevoId(),
      eventoId: entrada.eventoId ?? null,
      descripcion: entrada.descripcion.trim(),
      fechaGasto: entrada.fechaGasto,
      importeTotalCentimos: entrada.importeTotalCentimos,
      pagadoPorParticipanteId: entrada.pagadoPorParticipanteId,
      movimientoRealId: movReal?.id ?? null,
      cuotas: entrada.cuotas,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    validarGastoCompartido(compartido);

    const tx = this.obtenerDb().transaction(
      [
        ALMACENES.GASTOS_COMPARTIDOS,
        ALMACENES.TRANSACCIONES,
        ALMACENES.AUDITORIA,
        ALMACENES.COLA_SYNC,
      ],
      'readwrite',
    );
    if (movReal) {
      tx.objectStore(ALMACENES.TRANSACCIONES).put(movReal);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'transacciones',
        registroId: movReal.id,
        accion: 'CREACION',
        operacionSync: 'UPSERT',
        antes: null,
        despues: movReal,
        ahora,
      });
    }
    tx.objectStore(ALMACENES.GASTOS_COMPARTIDOS).put(compartido);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_compartidos',
      registroId: compartido.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: compartido,
      ahora,
    });
    await txCompleta(tx);
    return compartido;
  }

  async registrarLiquidacionCompartida(entrada: {
    id?: string;
    eventoId?: string | null;
    gastoCompartidoId?: string | null;
    fechaLiquidacion: string;
    deudorParticipanteId: string;
    acreedorParticipanteId: string;
    montoCentimos: MontoMinor;
    nota?: string | null;
  }): Promise<LiquidacionCompartida> {
    const ahora = ahoraISO();
    const liq: LiquidacionCompartida = {
      id: entrada.id ?? nuevoId(),
      eventoId: entrada.eventoId ?? null,
      gastoCompartidoId: entrada.gastoCompartidoId ?? null,
      fechaLiquidacion: entrada.fechaLiquidacion,
      deudorParticipanteId: entrada.deudorParticipanteId,
      acreedorParticipanteId: entrada.acreedorParticipanteId,
      montoCentimos: entrada.montoCentimos,
      movimientoRealId: null,
      nota: entrada.nota?.trim() ? entrada.nota.trim() : null,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    validarLiquidacionCompartida(liq);

    const tx = this.obtenerDb().transaction(
      [ALMACENES.LIQUIDACIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.LIQUIDACIONES).put(liq);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'liquidaciones_compartidas',
      registroId: liq.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: liq,
      ahora,
    });
    await txCompleta(tx);
    return liq;
  }

  async eliminarGastoCompartidoLogicamente(gastoCompartidoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const g = inst.gastosCompartidos.find((x) => x.id === gastoCompartidoId && x.estado === 'ACTIVO');
    if (!g) throw new Error('Gasto compartido no encontrado');
    const ahora = ahoraISO();
    const eliminado: GastoCompartido = {
      ...g,
      estado: 'ELIMINADO',
      auditoria: { ...g.auditoria, actualizadoEn: ahora, eliminadoEn: ahora, version: g.auditoria.version + 1 },
    };
    const movVinculado = g.movimientoRealId
      ? inst.movimientos.find((m) => m.id === g.movimientoRealId && m.estado === 'ACTIVO')
      : undefined;
    const tx = this.obtenerDb().transaction(
      [
        ALMACENES.GASTOS_COMPARTIDOS,
        ALMACENES.TRANSACCIONES,
        ALMACENES.AUDITORIA,
        ALMACENES.COLA_SYNC,
      ],
      'readwrite',
    );
    tx.objectStore(ALMACENES.GASTOS_COMPARTIDOS).put(eliminado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'gastos_compartidos',
      registroId: gastoCompartidoId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: g,
      despues: eliminado,
      ahora,
    });
    if (movVinculado) {
      const movEliminado: MovimientoFinanciero = {
        ...movVinculado,
        estado: 'ELIMINADO',
        auditoria: {
          ...movVinculado.auditoria,
          actualizadoEn: ahora,
          eliminadoEn: ahora,
          version: movVinculado.auditoria.version + 1,
        },
      };
      tx.objectStore(ALMACENES.TRANSACCIONES).put(movEliminado);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'transacciones',
        registroId: movVinculado.id,
        accion: 'ELIMINACION_LOGICA',
        operacionSync: 'ELIMINACION_LOGICA',
        antes: movVinculado,
        despues: movEliminado,
        ahora,
      });
    }
    await txCompleta(tx);
  }

  // ───────────────────────── MÓDULO 6: REGLAS DE RECURRENCIA ─────────────────────────
  async crearReglaRecurrencia(entrada: {
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
  }): Promise<ReglaRecurrencia> {
    const ahora = ahoraISO();
    const regla: ReglaRecurrencia = {
      id: entrada.id ?? nuevoId(),
      nombre: entrada.nombre.trim(),
      tipo: entrada.tipo,
      montoEstimadoCentimos: entrada.montoEstimadoCentimos,
      cuentaId: entrada.cuentaId,
      categoriaId: entrada.categoriaId,
      subcategoriaId: entrada.subcategoriaId ?? null,
      eventoId: entrada.eventoId ?? null,
      frecuencia: entrada.frecuencia,
      intervaloDias:
        entrada.frecuencia === 'PERSONALIZADA_DIAS' ? (entrada.intervaloDias ?? 15) : null,
      fechaInicio: entrada.fechaInicio,
      fechaFin: entrada.fechaFin ?? null,
      etiquetas: normalizarEtiquetas(entrada.etiquetas ?? []),
      fechasMaterializadas: {},
      fechasOmitidas: [],
      activa: true,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    validarReglaRecurrencia(regla);

    const tx = this.obtenerDb().transaction(
      [ALMACENES.RECURRENCIA, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.RECURRENCIA).put(regla);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'reglas_recurrencia',
      registroId: regla.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: regla,
      ahora,
    });
    await txCompleta(tx);
    return regla;
  }

  async autorizarOcurrenciaRecurrente(entrada: {
    reglaId: string;
    fechaProgramada: string;
    montoRealCentimos?: MontoMinor;
    fechaMovimientoReal?: string;
  }): Promise<{ reglaActualizada: ReglaRecurrencia; movimientoReal: MovimientoFinanciero }> {
    const inst = await this.obtenerInstantanea();
    const regla = inst.reglasRecurrencia.find(
      (r) => r.id === entrada.reglaId && r.estado === 'ACTIVO',
    );
    if (!regla) throw new Error('Regla de recurrencia no encontrada');
    if (regla.fechasMaterializadas[entrada.fechaProgramada]) {
      throw new Error(
        `La ocurrencia del ${entrada.fechaProgramada} ya fue autorizada y registrada previamente.`,
      );
    }

    const ahora = ahoraISO();
    const ctx = {
      cuentas: new Map(inst.cuentas.map((c) => [c.id, c])),
      categorias: new Map(inst.categorias.map((c) => [c.id, c])),
      eventos: new Map(
        inst.eventos.map((e) => [
          e.id,
          {
            ...e,
            presupuestoCentimos: e.presupuestoTotalCentimos,
            estadoEvento:
              e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
          },
        ]),
      ),
    };
    const movReal = crearMovimientoNuevo({
      id: nuevoId(),
      fechaMovimiento: entrada.fechaMovimientoReal ?? entrada.fechaProgramada,
      horaMovimiento: '12:00',
      registradoEn: ahora,
      tipo: regla.tipo,
      cuentaId: regla.cuentaId,
      categoriaId: regla.categoriaId,
      subcategoriaId: regla.subcategoriaId,
      montoCentimos: entrada.montoRealCentimos ?? regla.montoEstimadoCentimos,
      descripcion: `${regla.nombre} (compromiso recurrente ${entrada.fechaProgramada})`,
      eventoId: regla.eventoId,
      etiquetas: regla.etiquetas,
      origen: 'MANUAL',
      ctx,
    });

    const reglaActualizada: ReglaRecurrencia = {
      ...regla,
      fechasMaterializadas: {
        ...regla.fechasMaterializadas,
        [entrada.fechaProgramada]: movReal.id,
      },
      auditoria: {
        ...regla.auditoria,
        actualizadoEn: ahora,
        version: regla.auditoria.version + 1,
      },
    };

    const tx = this.obtenerDb().transaction(
      [ALMACENES.TRANSACCIONES, ALMACENES.RECURRENCIA, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(movReal);
    tx.objectStore(ALMACENES.RECURRENCIA).put(reglaActualizada);

    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: movReal.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: movReal,
      ahora,
    });
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'reglas_recurrencia',
      registroId: reglaActualizada.id,
      accion: 'MODIFICACION',
      operacionSync: 'UPSERT',
      antes: regla,
      despues: reglaActualizada,
      ahora,
    });

    await txCompleta(tx);
    return { reglaActualizada, movimientoReal: movReal };
  }

  async eliminarReglaRecurrenciaLogicamente(reglaId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const r = inst.reglasRecurrencia.find((x) => x.id === reglaId && x.estado === 'ACTIVO');
    if (!r) throw new Error('Regla de recurrencia no encontrada');
    const ahora = ahoraISO();
    const eliminada: ReglaRecurrencia = {
      ...r,
      activa: false,
      estado: 'ELIMINADO',
      auditoria: { ...r.auditoria, actualizadoEn: ahora, eliminadoEn: ahora, version: r.auditoria.version + 1 },
    };
    const tx = this.obtenerDb().transaction(
      [ALMACENES.RECURRENCIA, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.RECURRENCIA).put(eliminada);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'reglas_recurrencia',
      registroId: reglaId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: r,
      despues: eliminada,
      ahora,
    });
    await txCompleta(tx);
  }

  // ───────────────────────── PRESUPUESTOS MENSUALES Y MOVIMIENTOS ─────────────────────────
  async guardarPresupuesto(entrada: {
    periodoMes: string;
    categoriaId: string;
    limiteCentimos: MontoMinor;
  }): Promise<PresupuestoCategoria> {
    if (!/^\d{4}-\d{2}$/.test(entrada.periodoMes)) throw new Error('Periodo mensual inválido (use YYYY-MM)');
    if (entrada.limiteCentimos <= 0) throw new Error('El límite del presupuesto debe ser mayor que cero');
    const inst = await this.obtenerInstantanea();
    const existente = inst.presupuestos.find(
      (p) =>
        p.estado === 'ACTIVO' &&
        p.periodoMes === entrada.periodoMes &&
        p.categoriaId === entrada.categoriaId,
    );
    const ahora = ahoraISO();
    const tx = this.obtenerDb().transaction([ALMACENES.PRESUPUESTOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    if (existente) {
      const actualizado: PresupuestoCategoria = {
        ...existente,
        limiteCentimos: entrada.limiteCentimos,
        auditoria: {
          ...existente.auditoria,
          actualizadoEn: ahora,
          version: existente.auditoria.version + 1,
        },
      };
      tx.objectStore(ALMACENES.PRESUPUESTOS).put(actualizado);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'presupuestos',
        registroId: actualizado.id,
        accion: 'MODIFICACION',
        operacionSync: 'UPSERT',
        antes: existente,
        despues: actualizado,
        ahora,
      });
      await txCompleta(tx);
      return actualizado;
    }
    const nuevo: PresupuestoCategoria = {
      id: nuevoId(),
      periodoMes: entrada.periodoMes,
      categoriaId: entrada.categoriaId,
      limiteCentimos: entrada.limiteCentimos,
      estado: 'ACTIVO',
      auditoria: {
        origen: 'MANUAL',
        creadoEn: ahora,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: 1,
        loteImportacionId: null,
      },
    };
    tx.objectStore(ALMACENES.PRESUPUESTOS).put(nuevo);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'presupuestos',
      registroId: nuevo.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: nuevo,
      ahora,
    });
    await txCompleta(tx);
    return nuevo;
  }

  async eliminarPresupuestoLogicamente(presupuestoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const p = inst.presupuestos.find((x) => x.id === presupuestoId && x.estado === 'ACTIVO');
    if (!p) throw new Error('Presupuesto no encontrado');
    const ahora = ahoraISO();
    const eliminado: PresupuestoCategoria = {
      ...p,
      estado: 'ELIMINADO',
      auditoria: { ...p.auditoria, actualizadoEn: ahora, eliminadoEn: ahora, version: p.auditoria.version + 1 },
    };
    const tx = this.obtenerDb().transaction([ALMACENES.PRESUPUESTOS, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC], 'readwrite');
    tx.objectStore(ALMACENES.PRESUPUESTOS).put(eliminado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'presupuestos',
      registroId: presupuestoId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: p,
      despues: eliminado,
      ahora,
    });
    await txCompleta(tx);
  }

  async registrarMovimiento(entrada: EntradaCrearMovimiento): Promise<MovimientoFinanciero> {
    const inst = await this.obtenerInstantanea();
    const ctx = {
      cuentas: new Map(inst.cuentas.map((c) => [c.id, c])),
      categorias: new Map(inst.categorias.map((c) => [c.id, c])),
      eventos: new Map(
        inst.eventos.map((e) => [
          e.id,
          {
            ...e,
            presupuestoCentimos: e.presupuestoTotalCentimos,
            estadoEvento: e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
          },
        ]),
      ),
    };

    const destino = entrada.cuentaDestinoId ? ctx.cuentas.get(entrada.cuentaDestinoId) : undefined;
    const esPagoTarjeta =
      entrada.tipo === 'TRANSFERENCIA' &&
      (Boolean(entrada.esPagoTarjeta) || destino?.tipo === 'TARJETA_CREDITO');

    const mov = crearMovimientoNuevo({
      id: entrada.id ?? nuevoId(),
      fechaMovimiento: entrada.fechaMovimiento,
      horaMovimiento: entrada.horaMovimiento,
      tipo: entrada.tipo,
      categoriaId: entrada.categoriaId,
      subcategoriaId: entrada.subcategoriaId,
      cuentaId: entrada.cuentaId,
      cuentaDestinoId: entrada.cuentaDestinoId,
      montoCentimos: entrada.montoCentimos,
      etiquetas: entrada.etiquetas,
      descripcion: entrada.descripcion,
      eventoId: entrada.eventoId,
      esPagoTarjeta,
      origen: entrada.origen ?? 'MANUAL',
      ctx,
    });

    const tx = this.obtenerDb().transaction(
      [ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(mov);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: mov.id,
      accion: 'CREACION',
      operacionSync: 'UPSERT',
      antes: null,
      despues: mov,
      ahora: mov.registradoEn,
    });
    await txCompleta(tx);
    return mov;
  }

  async editarMovimiento(entrada: EntradaActualizarMovimiento): Promise<MovimientoFinanciero> {
    const inst = await this.obtenerInstantanea();
    const existente = inst.movimientos.find((m) => m.id === entrada.id && m.estado === 'ACTIVO');
    if (!existente) throw new Error('El movimiento no existe o está eliminado');

    const ctx = {
      cuentas: new Map(inst.cuentas.map((c) => [c.id, c])),
      categorias: new Map(inst.categorias.map((c) => [c.id, c])),
      eventos: new Map(
        inst.eventos.map((e) => [
          e.id,
          {
            ...e,
            presupuestoCentimos: e.presupuestoTotalCentimos,
            estadoEvento: e.estadoEvento === 'FINALIZADO' ? ('FINALIZADO' as const) : ('ACTIVO' as const),
          },
        ]),
      ),
    };

    const tipoNuevo = entrada.tipo ?? existente.tipo;
    const cuentaDestinoId =
      tipoNuevo === 'TRANSFERENCIA'
        ? entrada.cuentaDestinoId !== undefined
          ? entrada.cuentaDestinoId
          : existente.cuentaDestinoId
        : null;
    const destino = cuentaDestinoId ? ctx.cuentas.get(cuentaDestinoId) : undefined;
    const ahora = ahoraISO();

    const actualizado: MovimientoFinanciero = {
      ...existente,
      fechaMovimiento: entrada.fechaMovimiento ?? existente.fechaMovimiento,
      horaMovimiento: entrada.horaMovimiento ?? existente.horaMovimiento,
      tipo: tipoNuevo,
      categoriaId:
        tipoNuevo === 'INGRESO' || tipoNuevo === 'GASTO'
          ? entrada.categoriaId !== undefined
            ? entrada.categoriaId
            : existente.categoriaId
          : null,
      subcategoriaId:
        tipoNuevo === 'INGRESO' || tipoNuevo === 'GASTO'
          ? entrada.subcategoriaId !== undefined
            ? entrada.subcategoriaId
            : existente.subcategoriaId
          : null,
      cuentaId: entrada.cuentaId ?? existente.cuentaId,
      cuentaDestinoId,
      montoCentimos: entrada.montoCentimos ?? existente.montoCentimos,
      etiquetas:
        entrada.etiquetas !== undefined
          ? normalizarEtiquetas(entrada.etiquetas)
          : existente.etiquetas,
      descripcion:
        entrada.descripcion !== undefined
          ? entrada.descripcion?.trim()
            ? entrada.descripcion.trim()
            : null
          : existente.descripcion,
      eventoId: entrada.eventoId !== undefined ? entrada.eventoId : existente.eventoId,
      esPagoTarjeta:
        tipoNuevo === 'TRANSFERENCIA'
          ? entrada.esPagoTarjeta !== undefined
            ? entrada.esPagoTarjeta
            : Boolean(existente.esPagoTarjeta || destino?.tipo === 'TARJETA_CREDITO')
          : false,
      auditoria: {
        ...existente.auditoria,
        actualizadoEn: ahora,
        version: existente.auditoria.version + 1,
      },
    };

    validarMovimiento(actualizado, ctx);

    const tx = this.obtenerDb().transaction(
      [ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(actualizado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: actualizado.id,
      accion: 'MODIFICACION',
      operacionSync: 'UPSERT',
      antes: existente,
      despues: actualizado,
      ahora,
    });
    await txCompleta(tx);
    return actualizado;
  }

  async eliminarMovimientoLogicamente(movimientoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const existente = inst.movimientos.find((m) => m.id === movimientoId && m.estado === 'ACTIVO');
    if (!existente) throw new Error('El movimiento no existe o ya está eliminado');

    const ahora = ahoraISO();
    const eliminado: MovimientoFinanciero = {
      ...existente,
      estado: 'ELIMINADO',
      auditoria: {
        ...existente.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: ahora,
        version: existente.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction(
      [ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(eliminado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: movimientoId,
      accion: 'ELIMINACION_LOGICA',
      operacionSync: 'ELIMINACION_LOGICA',
      antes: existente,
      despues: eliminado,
      ahora,
    });
    await txCompleta(tx);
  }

  async restaurarMovimiento(movimientoId: string): Promise<void> {
    const inst = await this.obtenerInstantanea();
    const existente = inst.movimientos.find((m) => m.id === movimientoId && m.estado === 'ELIMINADO');
    if (!existente) throw new Error('El movimiento no está en la papelera');

    const ahora = ahoraISO();
    const restaurado: MovimientoFinanciero = {
      ...existente,
      estado: 'ACTIVO',
      auditoria: {
        ...existente.auditoria,
        actualizadoEn: ahora,
        eliminadoEn: null,
        version: existente.auditoria.version + 1,
      },
    };
    const tx = this.obtenerDb().transaction(
      [ALMACENES.TRANSACCIONES, ALMACENES.AUDITORIA, ALMACENES.COLA_SYNC],
      'readwrite',
    );
    tx.objectStore(ALMACENES.TRANSACCIONES).put(restaurado);
    this.registrarAuditoriaYSyncEnTx(tx, {
      entidad: 'transacciones',
      registroId: movimientoId,
      accion: 'RESTAURACION',
      operacionSync: 'UPSERT',
      antes: existente,
      despues: restaurado,
      ahora,
    });
    await txCompleta(tx);
  }

  async ejecutarImportacionTransaccional(params: {
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
  }): Promise<ResultadoEjecucionImportacion> {
    const filasConError = params.filasPrevisualizadas.filter((f) => f.estado === 'ERROR');
    if (filasConError.length > 0) {
      throw new Error(
        `La importación transaccional fue abortada porque existen ${filasConError.length} fila(s) con errores de validación.`,
      );
    }

    const inst = await this.obtenerInstantanea();
    const mapaMovsActuales = new Map(inst.movimientos.map((m) => [m.id, m]));
    const mapaCuentasActuales = new Map(inst.cuentas.map((c) => [c.id, c]));
    const mapaCategoriasActuales = new Map(inst.categorias.map((c) => [c.id, c]));
    const mapaEventosActuales = new Map(inst.eventos.map((e) => [e.id, e]));
    const mapaPresupuestosActuales = new Map(inst.presupuestos.map((p) => [p.id, p]));
    const mapaPlanificadosActuales = new Map(inst.gastosPlanificados.map((gp) => [gp.id, gp]));
    const mapaCompartidosActuales = new Map(inst.gastosCompartidos.map((gc) => [gc.id, gc]));
    const mapaLiquidacionesActuales = new Map(inst.liquidacionesCompartidas.map((lc) => [lc.id, lc]));
    const mapaRecurrenciaActuales = new Map(inst.reglasRecurrencia.map((rr) => [rr.id, rr]));
    const ahora = ahoraISO();

    const db = this.obtenerDb();
    const tx = db.transaction(
      [
        ALMACENES.CUENTAS,
        ALMACENES.CATEGORIAS,
        ALMACENES.EVENTOS,
        ALMACENES.PRESUPUESTOS,
        ALMACENES.TRANSACCIONES,
        ALMACENES.GASTOS_PLANIFICADOS,
        ALMACENES.GASTOS_COMPARTIDOS,
        ALMACENES.LIQUIDACIONES,
        ALMACENES.RECURRENCIA,
        ALMACENES.AUDITORIA,
        ALMACENES.COLA_SYNC,
      ],
      'readwrite',
    );

    for (const c of params.cuentasIncluidas ?? []) {
      const previo = mapaCuentasActuales.get(c.id) ?? null;
      tx.objectStore(ALMACENES.CUENTAS).put(c);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'cuentas',
        registroId: c.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: c,
        ahora,
      });
    }
    for (const cat of params.categoriasIncluidas ?? []) {
      const previo = mapaCategoriasActuales.get(cat.id) ?? null;
      tx.objectStore(ALMACENES.CATEGORIAS).put(cat);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'categorias',
        registroId: cat.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: cat,
        ahora,
      });
    }
    for (const evCrudo of params.eventosIncluidos ?? []) {
      const ev = normalizarEventoUniversal(
        evCrudo as Parameters<typeof normalizarEventoUniversal>[0],
      );
      const previo = mapaEventosActuales.get(ev.id) ?? null;
      tx.objectStore(ALMACENES.EVENTOS).put(ev);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'eventos',
        registroId: ev.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: ev,
        ahora,
      });
    }
    for (const pr of params.presupuestosIncluidos ?? []) {
      const previo = mapaPresupuestosActuales.get(pr.id) ?? null;
      tx.objectStore(ALMACENES.PRESUPUESTOS).put(pr);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'presupuestos',
        registroId: pr.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: pr,
        ahora,
      });
    }
    for (const gp of params.gastosPlanificadosIncluidos ?? []) {
      const previo = mapaPlanificadosActuales.get(gp.id) ?? null;
      tx.objectStore(ALMACENES.GASTOS_PLANIFICADOS).put(gp);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'gastos_planificados',
        registroId: gp.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: gp,
        ahora,
      });
    }
    for (const gc of params.gastosCompartidosIncluidos ?? []) {
      const previo = mapaCompartidosActuales.get(gc.id) ?? null;
      tx.objectStore(ALMACENES.GASTOS_COMPARTIDOS).put(gc);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'gastos_compartidos',
        registroId: gc.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: gc,
        ahora,
      });
    }
    for (const lc of params.liquidacionesCompartidasIncluidas ?? []) {
      const previo = mapaLiquidacionesActuales.get(lc.id) ?? null;
      tx.objectStore(ALMACENES.LIQUIDACIONES).put(lc);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'liquidaciones_compartidas',
        registroId: lc.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: lc,
        ahora,
      });
    }
    for (const rr of params.reglasRecurrenciaIncluidas ?? []) {
      const previo = mapaRecurrenciaActuales.get(rr.id) ?? null;
      tx.objectStore(ALMACENES.RECURRENCIA).put(rr);
      this.registrarAuditoriaYSyncEnTx(tx, {
        entidad: 'reglas_recurrencia',
        registroId: rr.id,
        accion: 'IMPORTACION',
        operacionSync: 'UPSERT',
        antes: previo,
        despues: rr,
        ahora,
      });
    }

    let insertados = 0;
    let sobrescritos = 0;
    let omitidosPorDuplicado = 0;

    for (const fila of params.filasPrevisualizadas) {
      const mov = fila.movimientoPropuesto;
      if (!mov) continue;

      if (fila.estado === 'NUEVO') {
        tx.objectStore(ALMACENES.TRANSACCIONES).put(mov);
        this.registrarAuditoriaYSyncEnTx(tx, {
          entidad: 'transacciones',
          registroId: mov.id,
          accion: 'IMPORTACION',
          operacionSync: 'UPSERT',
          antes: null,
          despues: mov,
          ahora,
        });
        insertados++;
      } else if (fila.estado === 'DUPLICADO_ID' || fila.estado === 'DUPLICADO_HUELLA') {
        if (params.politicaDuplicados === 'OMITIR') {
          omitidosPorDuplicado++;
        } else {
          const idDestino = fila.idExistenteCoincidente ?? mov.id;
          const previo = mapaMovsActuales.get(idDestino) ?? null;
          const reemplazo: MovimientoFinanciero = {
            ...mov,
            id: idDestino,
            auditoria: {
              ...mov.auditoria,
              creadoEn: previo?.auditoria.creadoEn ?? mov.auditoria.creadoEn,
              actualizadoEn: ahora,
              version: (previo?.auditoria.version ?? 1) + 1,
              loteImportacionId: params.loteId,
            },
          };
          tx.objectStore(ALMACENES.TRANSACCIONES).put(reemplazo);
          this.registrarAuditoriaYSyncEnTx(tx, {
            entidad: 'transacciones',
            registroId: reemplazo.id,
            accion: 'IMPORTACION',
            operacionSync: 'UPSERT',
            antes: previo,
            despues: reemplazo,
            ahora,
          });
          sobrescritos++;
        }
      }
    }

    await txCompleta(tx);
    return { loteId: params.loteId, insertados, sobrescritos, omitidosPorDuplicado };
  }

  async listarAuditoria(limite = 100): Promise<RegistroAuditoriaLocal[]> {
    const todos = await reqAPromesa<RegistroAuditoriaLocal[]>(
      this.obtenerDb().transaction([ALMACENES.AUDITORIA], 'readonly').objectStore(ALMACENES.AUDITORIA).getAll(),
    );
    return todos.sort((a, b) => (a.ocurridoEn < b.ocurridoEn ? 1 : -1)).slice(0, limite);
  }

  async listarCambiosPendientesSincronizacion(): Promise<CambioPendienteSincronizacion[]> {
    return reqAPromesa<CambioPendienteSincronizacion[]>(
      this.obtenerDb().transaction([ALMACENES.COLA_SYNC], 'readonly').objectStore(ALMACENES.COLA_SYNC).getAll(),
    );
  }

  private almacenPorEntidad(entidad: NombreEntidadSincronizable): string {
    switch (entidad) {
      case 'cuentas':
        return ALMACENES.CUENTAS;
      case 'categorias':
        return ALMACENES.CATEGORIAS;
      case 'eventos':
        return ALMACENES.EVENTOS;
      case 'presupuestos':
        return ALMACENES.PRESUPUESTOS;
      case 'transacciones':
        return ALMACENES.TRANSACCIONES;
      case 'gastos_planificados':
        return ALMACENES.GASTOS_PLANIFICADOS;
      case 'gastos_compartidos':
        return ALMACENES.GASTOS_COMPARTIDOS;
      case 'liquidaciones_compartidas':
        return ALMACENES.LIQUIDACIONES;
      case 'reglas_recurrencia':
        return ALMACENES.RECURRENCIA;
    }
  }

  async listarConflictosSincronizacion(): Promise<ConflictoSincronizacion[]> {
    const db = this.obtenerDb();
    const reg = await reqAPromesa<{ clave: string; valor: ConflictoSincronizacion[] } | undefined>(
      db.transaction([ALMACENES.METADATOS], 'readonly').objectStore(ALMACENES.METADATOS).get('conflictos_sincronizacion'),
    );
    return reg?.valor ?? [];
  }

  async sincronizarConTransporte(params: {
    transporte: TransporteNubeRls;
    propietarioId: string;
    dispositivoId: string;
  }): Promise<{
    enviados: number;
    recibidos: number;
    conflictosDetectados: number;
    ultimaSincronizacionIso: string;
  }> {
    const db = this.obtenerDb();
    const txMeta = db.transaction([ALMACENES.METADATOS, ALMACENES.COLA_SYNC], 'readonly');
    const [metaCursor, metaVersiones, metaConflictos, colaActual] = await Promise.all([
      reqAPromesa<{ clave: string; valor: string } | undefined>(
        txMeta.objectStore(ALMACENES.METADATOS).get('cursor_sincronizacion'),
      ),
      reqAPromesa<{ clave: string; valor: Record<string, number> } | undefined>(
        txMeta.objectStore(ALMACENES.METADATOS).get('versiones_base_sync'),
      ),
      reqAPromesa<{ clave: string; valor: ConflictoSincronizacion[] } | undefined>(
        txMeta.objectStore(ALMACENES.METADATOS).get('conflictos_sincronizacion'),
      ),
      reqAPromesa<CambioPendienteSincronizacion[]>(
        txMeta.objectStore(ALMACENES.COLA_SYNC).getAll(),
      ),
    ]);

    const cursorPrevio = metaCursor?.valor ?? null;
    const mapaVersionesBase: Record<string, number> = { ...(metaVersiones?.valor ?? {}) };
    const conflictosVigentes = new Map<string, ConflictoSincronizacion>(
      (metaConflictos?.valor ?? []).map((c) => [c.id, c]),
    );

    // 1. Descargar novedades desde la nube
    const descarga = await params.transporte.descargarSobresDesde(
      params.propietarioId,
      cursorPrevio,
    );

    const mapaColaLocal = new Map(colaActual.map((c) => [c.id, c]));
    const sobresRemotosParaAplicar: SobreSincronizacion[] = [];
    const idsColaParaEliminar = new Set<string>();
    let conflictosDetectados = 0;

    for (const sobreRemoto of descarga.sobres) {
      const llave = `${sobreRemoto.entidad}:${sobreRemoto.id}`;
      const cambioPendiente = mapaColaLocal.get(llave);

      if (cambioPendiente) {
        const versionBase = mapaVersionesBase[llave] ?? 0;
        const sobreLocal = construirSobreSincronizacion({
          entidad: cambioPendiente.entidad,
          registro: cambioPendiente.carga as Record<string, unknown>,
          propietarioId: params.propietarioId,
          dispositivoId: params.dispositivoId,
          versionBaseConocida: versionBase,
        });
        const evalConc = evaluarCambioConcurrente(sobreLocal, sobreRemoto);
        if (evalConc.resultado === 'CONFLICTO_DETECTADO') {
          conflictosVigentes.set(evalConc.conflicto.id, evalConc.conflicto);
          idsColaParaEliminar.add(llave);
          conflictosDetectados += 1;
        } else if (evalConc.resultado === 'IDEMPOTENTE_YA_SINCRONIZADO') {
          idsColaParaEliminar.add(llave);
          mapaVersionesBase[llave] = sobreRemoto.version;
          sobresRemotosParaAplicar.push(evalConc.sobreActual);
        }
      } else {
        sobresRemotosParaAplicar.push(sobreRemoto);
        mapaVersionesBase[llave] = sobreRemoto.version;
      }
    }

    // 2. Empujar cambios locales pendientes que no hayan entrado en conflicto
    const sobresParaEmpujar: SobreSincronizacion[] = [];
    for (const itemCola of colaActual) {
      if (idsColaParaEliminar.has(itemCola.id)) continue;
      const versionBase = mapaVersionesBase[itemCola.id] ?? 0;
      sobresParaEmpujar.push(
        construirSobreSincronizacion({
          entidad: itemCola.entidad,
          registro: itemCola.carga as Record<string, unknown>,
          propietarioId: params.propietarioId,
          dispositivoId: params.dispositivoId,
          versionBaseConocida: versionBase,
        }),
      );
    }

    let enviados = 0;
    if (sobresParaEmpujar.length > 0) {
      const resPush = await params.transporte.empujarSobres(
        params.propietarioId,
        sobresParaEmpujar,
      );
      for (const ap of resPush.aplicados) {
        const llave = `${ap.entidad}:${ap.id}`;
        idsColaParaEliminar.add(llave);
        mapaVersionesBase[llave] = ap.version;
        sobresRemotosParaAplicar.push(ap);
        enviados += 1;
      }
      for (const conf of resPush.conflictos) {
        const llave = `${conf.entidad}:${conf.registroId}`;
        conflictosVigentes.set(conf.id, conf);
        idsColaParaEliminar.add(llave);
        conflictosDetectados += 1;
      }
    }

    // 3. Persistir atómicamente en IndexedDB los registros recibidos, limpiar cola sincronizada y guardar metadatos
    const ahora = ahoraISO();
    const almacenesInvolucrados = [
      ALMACENES.METADATOS,
      ALMACENES.COLA_SYNC,
      ALMACENES.CUENTAS,
      ALMACENES.CATEGORIAS,
      ALMACENES.EVENTOS,
      ALMACENES.PRESUPUESTOS,
      ALMACENES.TRANSACCIONES,
      ALMACENES.GASTOS_PLANIFICADOS,
      ALMACENES.GASTOS_COMPARTIDOS,
      ALMACENES.LIQUIDACIONES,
      ALMACENES.RECURRENCIA,
    ];
    const txWrite = db.transaction(almacenesInvolucrados, 'readwrite');

    for (const sobre of sobresRemotosParaAplicar) {
      const nombreStore = this.almacenPorEntidad(sobre.entidad);
      txWrite.objectStore(nombreStore).put(sobre.datos);
    }

    const syncStore = txWrite.objectStore(ALMACENES.COLA_SYNC);
    for (const idBorrar of idsColaParaEliminar) {
      syncStore.delete(idBorrar);
    }

    const metaStore = txWrite.objectStore(ALMACENES.METADATOS);
    metaStore.put({ clave: 'cursor_sincronizacion', valor: descarga.cursorNuevoIso });
    metaStore.put({ clave: 'ultima_sincronizacion_iso', valor: ahora });
    metaStore.put({ clave: 'versiones_base_sync', valor: mapaVersionesBase });
    metaStore.put({
      clave: 'conflictos_sincronizacion',
      valor: [...conflictosVigentes.values()],
    });

    await txCompleta(txWrite);

    return {
      enviados,
      recibidos: descarga.sobres.length,
      conflictosDetectados,
      ultimaSincronizacionIso: ahora,
    };
  }

  async resolverConflictoSincronizacion(params: {
    conflictoId: string;
    estrategia: EstrategiaResolucionConflicto;
    dispositivoId: string;
  }): Promise<void> {
    const db = this.obtenerDb();
    const txRead = db.transaction([ALMACENES.METADATOS], 'readonly');
    const [metaConf, metaVer] = await Promise.all([
      reqAPromesa<{ clave: string; valor: ConflictoSincronizacion[] } | undefined>(
        txRead.objectStore(ALMACENES.METADATOS).get('conflictos_sincronizacion'),
      ),
      reqAPromesa<{ clave: string; valor: Record<string, number> } | undefined>(
        txRead.objectStore(ALMACENES.METADATOS).get('versiones_base_sync'),
      ),
    ]);

    const lista = metaConf?.valor ?? [];
    const conflicto = lista.find((c) => c.id === params.conflictoId);
    if (!conflicto) {
      throw new Error(`El conflicto ${params.conflictoId} no existe.`);
    }

    const sobreResuelto = construirSobreResueltoDeConflicto(
      conflicto as ConflictoSincronizacion<Record<string, unknown>>,
      params.estrategia,
      params.dispositivoId,
    );

    const nombreStore = this.almacenPorEntidad(conflicto.entidad);
    const txWrite = db.transaction(
      [nombreStore, ALMACENES.METADATOS, ALMACENES.COLA_SYNC, ALMACENES.AUDITORIA],
      'readwrite',
    );

    txWrite.objectStore(nombreStore).put(sobreResuelto.datos);

    const mapaVersionesBase: Record<string, number> = { ...(metaVer?.valor ?? {}) };
    const llave = `${conflicto.entidad}:${conflicto.registroId}`;
    mapaVersionesBase[llave] = sobreResuelto.versionBaseConocida;

    if (params.estrategia === 'CONSERVAR_LOCAL') {
      txWrite.objectStore(ALMACENES.COLA_SYNC).put({
        id: llave,
        entidad: conflicto.entidad,
        registroId: conflicto.registroId,
        operacion: sobreResuelto.estado === 'ELIMINADO' ? 'ELIMINACION_LOGICA' : 'UPSERT',
        carga: sobreResuelto.datos,
        creadoEn: ahoraISO(),
        intentos: 0,
      } satisfies CambioPendienteSincronizacion);
    } else {
      txWrite.objectStore(ALMACENES.COLA_SYNC).delete(llave);
    }

    const restantes = lista.filter((c) => c.id !== params.conflictoId);
    txWrite.objectStore(ALMACENES.METADATOS).put({
      clave: 'conflictos_sincronizacion',
      valor: restantes,
    });
    txWrite.objectStore(ALMACENES.METADATOS).put({
      clave: 'versiones_base_sync',
      valor: mapaVersionesBase,
    });

    await txCompleta(txWrite);
  }

  async obtenerEstadoPersistenciaDispositivo(): Promise<EstadoPersistenciaDispositivo> {
    const db = this.obtenerDb();
    const tx = db.transaction([ALMACENES.METADATOS], 'readonly');
    const store = tx.objectStore(ALMACENES.METADATOS);
    const [regDisp, regUltima, regSesion, regBloqueo] = await Promise.all([
      reqAPromesa<{ clave: string; valor: string } | undefined>(store.get('dispositivo_id')),
      reqAPromesa<{ clave: string; valor: string } | undefined>(
        store.get('ultima_sincronizacion_iso'),
      ),
      reqAPromesa<{ clave: string; valor: SesionCloudPersistida | null } | undefined>(
        store.get('sesion_supabase_propietario'),
      ),
      reqAPromesa<{ clave: string; valor: VerificadorBloqueoPersistido | null } | undefined>(
        store.get('verificador_bloqueo_local'),
      ),
    ]);
    return {
      dispositivoId: regDisp?.valor ?? 'dispositivo-local',
      ultimaSincronizacionIso: regUltima?.valor ?? null,
      sesionCloud: regSesion?.valor ?? null,
      verificadorBloqueo: regBloqueo?.valor ?? null,
    };
  }

  async guardarSesionCloudPersistente(sesion: SesionCloudPersistida | null): Promise<void> {
    const db = this.obtenerDb();
    const tx = db.transaction([ALMACENES.METADATOS], 'readwrite');
    const store = tx.objectStore(ALMACENES.METADATOS);
    if (sesion) {
      store.put({ clave: 'sesion_supabase_propietario', valor: sesion });
    } else {
      store.delete('sesion_supabase_propietario');
    }
    await txCompleta(tx);
  }

  async guardarVerificadorBloqueoLocal(
    verificador: VerificadorBloqueoPersistido | null,
  ): Promise<void> {
    const db = this.obtenerDb();
    const tx = db.transaction([ALMACENES.METADATOS], 'readwrite');
    const store = tx.objectStore(ALMACENES.METADATOS);
    if (verificador) {
      store.put({ clave: 'verificador_bloqueo_local', valor: verificador });
    } else {
      store.delete('verificador_bloqueo_local');
    }
    await txCompleta(tx);
  }

  cerrar(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
