import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  AlmacenNubeConRls,
  calcularResumenPeriodo,
  crearVerificadorBloqueoLocal,
  exportarLibroAJson,
  exportarJsonCifradoConContrasena,
  importarJsonCifradoConContrasena,
  previsualizarImportacionJson,
  verificarCodigoBloqueoLocal,
  type SobreSincronizacion,
} from '@mis-cuentas/core';
import { ClienteSupabasePrivado } from '../src/persistencia/cliente_supabase';
import { RepositorioIndexedDB } from '../src/persistencia/indexeddb';

describe('Fase 5 en IndexedDB: Integridad de datos entre PC y Celular con desconexión, conflictos, eliminaciones y respaldo cifrado', () => {
  it('mantiene exactamente los mismos movimientos, eventos, presupuestos y saldos entre PC y Celular tras operar offline, resolver conflictos y restaurar respaldos', async () => {
    const propietarioUid = 'aaaa1111-bbbb-4222-8333-cccc44445555';
    const nubeRls = new AlmacenNubeConRls({ uidPropietarioAutorizado: propietarioUid });

    // Dos bases de datos IndexedDB completamente aisladas: una simula la PC y otra el Celular
    const repoPC = new RepositorioIndexedDB({
      nombreBd: 'idb_pc_escritorio',
      indexedDB: new IDBFactory(),
    });
    const repoCelular = new RepositorioIndexedDB({
      nombreBd: 'idb_celular_movil',
      indexedDB: new IDBFactory(),
    });

    await repoPC.inicializar();
    await repoCelular.inicializar();

    // 1. En PC se habilitan los catálogos base, se registra saldo inicial en Yape (S/ 1,500.00),
    //    un evento de viaje, un presupuesto mensual y un gasto de S/ 80.00
    await repoPC.activarMetodosInicialesSugeridos();
    await repoPC.activarCategoriasInicialesSugeridas();
    const instPc0 = await repoPC.obtenerInstantanea();
    const ctaYape = instPc0.cuentas.find((c) => c.nombre === 'Yape')!;
    const catAlim = instPc0.categorias.find((c) => c.nombre === 'Alimentación' && c.padreId === null)!;

    await repoPC.registrarOActualizarSaldoInicial({
      cuentaId: ctaYape.id,
      saldoInicialCentimos: 150_000,
      fechaSaldoInicial: '2026-04-01',
    });

    const evento = await repoPC.crearEvento({
      nombre: 'Cumbre Familiar',
      tipoEvento: 'VIAJE',
      fechaInicio: '2026-04-01',
      fechaFin: '2026-04-10',
      presupuestoTotalCentimos: 90_000,
    });

    await repoPC.guardarPresupuesto({
      periodoMes: '2026-04',
      categoriaId: catAlim.id,
      limiteCentimos: 60_000,
    });

    const movCompartido1 = await repoPC.registrarMovimiento({
      fechaMovimiento: '2026-04-02',
      horaMovimiento: '13:15',
      tipo: 'GASTO',
      cuentaId: ctaYape.id,
      categoriaId: catAlim.id,
      eventoId: evento.id,
      montoCentimos: 8_000,
      descripcion: 'Almuerzo registrado desde PC',
    });

    // Sincronizar PC -> Nube
    const syncPc1 = await repoPC.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'pc',
    });
    expect(syncPc1.conflictosDetectados).toBe(0);

    // 2. Sincronizar Nube -> Celular: el Celular (que estaba en blanco) recibe todas las cuentas, categorías, evento, presupuesto y movimientos
    const syncCel1 = await repoCelular.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'celular',
    });
    expect(syncCel1.recibidos).toBeGreaterThan(0);

    const instCel1 = await repoCelular.obtenerInstantanea();
    expect(instCel1.eventos.map((e) => e.nombre)).toEqual(['Cumbre Familiar']);
    expect(instCel1.presupuestos).toHaveLength(1);

    // 3. El Celular opera OFFLINE (sin sincronizar todavía) y registra un nuevo gasto de S/ 45.00
    //    y elimina lógicamente un gasto temporal creado y borrado en el celular
    const movCreadoOfflineEnCelular = await repoCelular.registrarMovimiento({
      fechaMovimiento: '2026-04-03',
      horaMovimiento: '19:40',
      tipo: 'GASTO',
      cuentaId: ctaYape.id,
      categoriaId: catAlim.id,
      eventoId: evento.id,
      montoCentimos: 4_500,
      descripcion: 'Cena registrada offline en Celular',
    });
    const movBorrar = await repoCelular.registrarMovimiento({
      fechaMovimiento: '2026-04-03',
      horaMovimiento: '20:00',
      tipo: 'GASTO',
      cuentaId: ctaYape.id,
      categoriaId: catAlim.id,
      montoCentimos: 1_000,
      descripcion: 'Movimiento anulado en Celular',
    });
    await repoCelular.eliminarMovimientoLogicamente(movBorrar.id);

    // 4. Simultáneamente, PC y Celular editan `movCompartido1` antes de sincronizar:
    //    - PC lo edita a S/ 85.00 (8500 céntimos) y sincroniza con la nube.
    //    - Celular (offline) lo edita a S/ 92.00 (9200 céntimos).
    await repoPC.editarMovimiento({
      id: movCompartido1.id,
      montoCentimos: 8_500,
      descripcion: 'Almuerzo editado en PC',
    });
    await repoPC.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'pc',
    });

    await repoCelular.editarMovimiento({
      id: movCompartido1.id,
      montoCentimos: 9_200,
      descripcion: 'Almuerzo editado en Celular offline',
    });

    // 5. Celular reconecta y sincroniza -> envía sus nuevos movimientos y detecta el conflicto en `movCompartido1` sin sobrescribir silenciosamente
    const syncCel2 = await repoCelular.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'celular',
    });
    expect(syncCel2.conflictosDetectados).toBe(1);

    const conflictosEnCelular = await repoCelular.listarConflictosSincronizacion();
    expect(conflictosEnCelular).toHaveLength(1);
    expect(conflictosEnCelular[0]!.registroId).toBe(movCompartido1.id);

    // Resolver el conflicto conservando la edición del Celular (S/ 92.00) y sincronizar ambos dispositivos
    await repoCelular.resolverConflictoSincronizacion({
      conflictoId: conflictosEnCelular[0]!.id,
      estrategia: 'CONSERVAR_LOCAL',
      dispositivoId: 'celular',
    });
    await repoCelular.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'celular',
    });
    await repoPC.sincronizarConTransporte({
      transporte: nubeRls,
      propietarioId: propietarioUid,
      dispositivoId: 'pc',
    });

    // 6. Verificar que PC y Celular tienen exactamente el mismo estado, movimientos y saldos contables
    const instFinalPC = await repoPC.obtenerInstantanea();
    const instFinalCel = await repoCelular.obtenerInstantanea();

    const resumenPC = calcularResumenPeriodo({
      periodoMes: '2026-04',
      cuentas: instFinalPC.cuentas,
      categorias: instFinalPC.categorias,
      movimientos: instFinalPC.movimientos,
      presupuestos: instFinalPC.presupuestos,
    });
    const resumenCel = calcularResumenPeriodo({
      periodoMes: '2026-04',
      cuentas: instFinalCel.cuentas,
      categorias: instFinalCel.categorias,
      movimientos: instFinalCel.movimientos,
      presupuestos: instFinalCel.presupuestos,
    });

    // Gastos activos: 9200 (movCompartido1 resuelto) + 4500 (movCreadoOfflineEnCelular) = 13700 (el eliminado lógicamente no suma)
    expect(resumenPC.egresosPeriodoCentimos).toBe(13_700);
    expect(resumenCel.egresosPeriodoCentimos).toBe(13_700);

    // Saldo bancario real de Yape: 150000 - 13700 = 136300 en ambos dispositivos
    expect(resumenPC.saldoRegistradoConocidoCentimos).toBe(136_300);
    expect(resumenCel.saldoRegistradoConocidoCentimos).toBe(136_300);

    // 7. Verificar exportación de respaldo JSON cifrado desde PC y restauración en un tercer dispositivo nuevo
    const jsonPlano = exportarLibroAJson({
      cuentas: instFinalPC.cuentas,
      categorias: instFinalPC.categorias,
      eventos: instFinalPC.eventos,
      presupuestos: instFinalPC.presupuestos,
      movimientos: instFinalPC.movimientos,
    });
    const respaldoCifrado = await exportarJsonCifradoConContrasena(
      JSON.parse(jsonPlano),
      'ClaveRespaldo#2026',
      15_000,
    );

    const repoDispositivoRecuperado = new RepositorioIndexedDB({
      nombreBd: 'idb_recuperacion_backup',
      indexedDB: new IDBFactory(),
    });
    await repoDispositivoRecuperado.inicializar();

    const descifrado = await importarJsonCifradoConContrasena(
      respaldoCifrado,
      'ClaveRespaldo#2026',
    );
    const loteId = 'lote-rec-1';
    const prev = previsualizarImportacionJson({
      contenidoJson: JSON.stringify(descifrado),
      movimientosExistentes: [],
      loteImportacionId: loteId,
    });
    await repoDispositivoRecuperado.ejecutarImportacionTransaccional({
      loteId,
      filasPrevisualizadas: prev.filas,
      politicaDuplicados: 'OMITIR',
      cuentasIncluidas: prev.cuentasIncluidas,
      categoriasIncluidas: prev.categoriasIncluidas,
      eventosIncluidos: prev.eventosIncluidos,
      presupuestosIncluidos: prev.presupuestosIncluidos,
    });

    const instRec = await repoDispositivoRecuperado.obtenerInstantanea();
    const resumenRec = calcularResumenPeriodo({
      periodoMes: '2026-04',
      cuentas: instRec.cuentas,
      categorias: instRec.categorias,
      movimientos: instRec.movimientos,
      presupuestos: instRec.presupuestos,
    });
    expect(resumenRec.egresosPeriodoCentimos).toBe(13_700);
    expect(resumenRec.saldoRegistradoConocidoCentimos).toBe(136_300);

    repoPC.cerrar();
    repoCelular.cerrar();
    repoDispositivoRecuperado.cerrar();
  });

  it('opera de forma 100 % independiente con la PC completamente apagada: registra offline en IndexedDB, sobrevive al cierre de la app y reinicio del celular, renueva sesión y sincroniza directo con Supabase Cloud por Internet móvil sin duplicados', async () => {
    const propietarioUid = '77777777-8888-4999-8000-111111111111';
    const emailPropietario = 'viajero@miscuentas.pe';
    const urlSupabaseCloud = 'https://viaje-tacna-cloud.supabase.co';
    const payloadAnon = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    const anonKeyValida = `eyJhbGciOiJIUzI1NiJ9.${payloadAnon}.firma_publica`;

    // Simulamos el backend cloud real de Supabase (PostgREST + GoTrue Auth) en Internet
    const tablasCloud = new Map<string, Map<string, Record<string, unknown>>>();
    const urlsInvocadasPorCelular: string[] = [];
    const fetchOriginal = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      urlsInvocadasPorCelular.push(urlStr);

      // Verificación estricta: ninguna petición puede ir a localhost, 127.0.0.1 ni IP privada de la PC
      const u = new URL(urlStr);
      expect(urlStr.startsWith(urlSupabaseCloud)).toBe(true);
      expect(u.hostname).not.toMatch(/^(localhost|127\.0\.0\.1|192\.168\.|10\.)/);

      // 1. Endpoint de autenticación / renovación de token en Supabase Auth Cloud
      if (u.pathname === '/auth/v1/token') {
        const grantType = u.searchParams.get('grant_type');
        if (grantType === 'password' || grantType === 'refresh_token') {
          return new Response(
            JSON.stringify({
              access_token: `jwt-cloud-${Date.now()}`,
              refresh_token: 'refresh-token-permanente-viaje',
              expires_in: 3600,
              user: { id: propietarioUid, email: emailPropietario },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }

      // 2. Endpoints PostgREST de las 9 tablas con RLS (propietario_id = auth.uid())
      if (u.pathname.startsWith('/rest/v1/')) {
        const tabla = u.pathname.replace('/rest/v1/', '');
        if (!tablasCloud.has(tabla)) {
          tablasCloud.set(tabla, new Map());
        }
        const almacenTabla = tablasCloud.get(tabla)!;
        const metodo = (init?.method ?? 'GET').toUpperCase();

        if (metodo === 'GET') {
          const idFiltro = u.searchParams.get('id');
          const updatedFiltro = u.searchParams.get('updated_at');
          let filas = [...almacenTabla.values()].filter(
            (f) => f.propietario_id === propietarioUid,
          );
          if (idFiltro?.startsWith('eq.')) {
            const idBuscado = idFiltro.slice(3);
            filas = filas.filter((f) => f.id === idBuscado);
          }
          if (updatedFiltro?.startsWith('gte.')) {
            const isoMin = updatedFiltro.slice(4);
            filas = filas.filter((f) => String(f.updated_at) >= isoMin);
          }
          return new Response(JSON.stringify(filas), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (metodo === 'POST') {
          const fila = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          const llave = `${String(fila.propietario_id)}:${String(fila.id)}`;
          almacenTabla.set(llave, fila);
          return new Response(JSON.stringify([fila]), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    };

    try {
      // ==================== FASE A: ANTES DEL VIAJE (PC CONFIGURA Y SE APAGA COMPLETAMENTE) ====================
      const fabricaIdbPC = new IDBFactory();
      const repoPC = new RepositorioIndexedDB({
        nombreBd: 'idb_pc_antes_del_viaje',
        indexedDB: fabricaIdbPC,
      });
      await repoPC.inicializar();

      const clientePc = new ClienteSupabasePrivado({
        url: urlSupabaseCloud,
        publishableKey: anonKeyValida,
        emailPropietarioAutorizado: emailPropietario,
      });
      const sesionPc = await clientePc.iniciarSesionConContrasena(
        emailPropietario,
        'ClaveViaje#2026',
      );

      await repoPC.activarMetodosInicialesSugeridos();
      await repoPC.activarCategoriasInicialesSugeridas();
      const instPc = await repoPC.obtenerInstantanea();
      const ctaEfectivo = instPc.cuentas.find((c) => c.nombre === 'Efectivo')!;
      const catAlim = instPc.categorias.find(
        (c) => c.nombre === 'Alimentación' && c.padreId === null,
      )!;

      await repoPC.registrarOActualizarSaldoInicial({
        cuentaId: ctaEfectivo.id,
        saldoInicialCentimos: 200_000, // S/ 2,000.00 para el viaje
        fechaSaldoInicial: '2026-05-01',
      });

      const eventoViaje = await repoPC.crearEvento({
        nombre: 'Viaje Frontera Sur',
        tipoEvento: 'VIAJE',
        fechaInicio: '2026-05-01',
        fechaFin: '2026-05-08',
        presupuestoTotalCentimos: 120_000,
      });

      // PC sincroniza con Supabase Cloud y SE APAGA COMPLETAMENTE
      await repoPC.sincronizarConTransporte({
        transporte: clientePc,
        propietarioId: sesionPc.uid,
        dispositivoId: 'pc-casa',
      });
      repoPC.cerrar(); // <--- PC APAGADA PARA SIEMPRE DURANTE TODO EL VIAJE

      // ==================== FASE B: CELULAR SE CONECTA A CLOUD ANTES DE SALIR ====================
      // `fabricaIdbCelular` representa la memoria flash persistente del teléfono móvil
      const fabricaIdbCelular = new IDBFactory();
      const repoCelularSesion1 = new RepositorioIndexedDB({
        nombreBd: 'mis_cuentas_permanente_v1',
        indexedDB: fabricaIdbCelular,
      });
      await repoCelularSesion1.inicializar();

      const clienteCelular1 = new ClienteSupabasePrivado({
        url: urlSupabaseCloud,
        publishableKey: anonKeyValida,
        emailPropietarioAutorizado: emailPropietario,
      });
      const sesionMovilInicial = await clienteCelular1.iniciarSesionConContrasena(
        emailPropietario,
        'ClaveViaje#2026',
      );

      // Persistir la sesión cloud y el PIN de bloqueo en el IndexedDB del celular
      await repoCelularSesion1.guardarSesionCloudPersistente(sesionMovilInicial);
      const pinVerificador = await crearVerificadorBloqueoLocal('2580', 10_000);
      await repoCelularSesion1.guardarVerificadorBloqueoLocal(pinVerificador);

      // El celular descarga las cuentas, categorías, saldo inicial y el evento desde Supabase Cloud
      const pullInicialMovil = await repoCelularSesion1.sincronizarConTransporte({
        transporte: clienteCelular1,
        propietarioId: sesionMovilInicial.uid,
        dispositivoId: (await repoCelularSesion1.obtenerInstantanea()).dispositivoId!,
      });
      expect(pullInicialMovil.recibidos).toBeGreaterThan(0);

      // ==================== FASE C: EN PLENO VIAJE SIN INTERNET (PC APAGADA + CELULAR OFFLINE) ====================
      // El usuario registra 3 movimientos en su celular sin internet (en ruta / frontera) y edita uno
      const movOffline1 = await repoCelularSesion1.registrarMovimiento({
        fechaMovimiento: '2026-05-02',
        horaMovimiento: '08:30',
        tipo: 'GASTO',
        cuentaId: ctaEfectivo.id,
        categoriaId: catAlim.id,
        eventoId: eventoViaje.id,
        montoCentimos: 2_500, // S/ 25.00
        descripcion: 'Desayuno en ruta (offline con PC apagada)',
      });
      const movOffline2 = await repoCelularSesion1.registrarMovimiento({
        fechaMovimiento: '2026-05-02',
        horaMovimiento: '14:10',
        tipo: 'GASTO',
        cuentaId: ctaEfectivo.id,
        categoriaId: catAlim.id,
        eventoId: eventoViaje.id,
        montoCentimos: 4_000, // S/ 40.00 -> luego editado a S/ 48.00
        descripcion: 'Almuerzo en viaje (offline)',
      });
      await repoCelularSesion1.editarMovimiento({
        id: movOffline2.id,
        montoCentimos: 4_800,
        descripcion: 'Almuerzo en viaje + bebida (editado offline)',
      });
      const movOffline3 = await repoCelularSesion1.registrarMovimiento({
        fechaMovimiento: '2026-05-02',
        horaMovimiento: '20:00',
        tipo: 'GASTO',
        cuentaId: ctaEfectivo.id,
        categoriaId: catAlim.id,
        eventoId: eventoViaje.id,
        montoCentimos: 3_200, // S/ 32.00
        descripcion: 'Cena en destino (offline)',
      });

      const instAntesDeCerrarApp = await repoCelularSesion1.obtenerInstantanea();
      expect(instAntesDeCerrarApp.cambiosPendientesSync).toBe(3);
      const idDispositivoOriginal = instAntesDeCerrarApp.dispositivoId!;

      // ==================== FASE D: CIERRE DE LA APP Y REINICIO COMPLETO DEL CELULAR ====================
      repoCelularSesion1.cerrar();

      // El teléfono se reinicia; el usuario vuelve a abrir la PWA instalada (aún sin PC y antes de sincronizar)
      const repoCelularTrasReinicio = new RepositorioIndexedDB({
        nombreBd: 'mis_cuentas_permanente_v1',
        indexedDB: fabricaIdbCelular,
      });
      await repoCelularTrasReinicio.inicializar();

      const instTrasReinicio = await repoCelularTrasReinicio.obtenerInstantanea();
      const estadoPersistidoTrasReinicio =
        await repoCelularTrasReinicio.obtenerEstadoPersistenciaDispositivo();

      // 1. Verificar que ningún movimiento pendiente ni metadato se perdió al cerrar la app o reiniciar el celular
      expect(instTrasReinicio.cambiosPendientesSync).toBe(3);
      expect(instTrasReinicio.dispositivoId).toBe(idDispositivoOriginal);
      expect(estadoPersistidoTrasReinicio.sesionCloud?.uid).toBe(propietarioUid);
      expect(estadoPersistidoTrasReinicio.verificadorBloqueo).not.toBeNull();
      expect(
        await verificarCodigoBloqueoLocal(
          '2580',
          estadoPersistidoTrasReinicio.verificadorBloqueo!,
        ),
      ).toBe(true);

      const resumenOfflineTrasReinicio = calcularResumenPeriodo({
        periodoMes: '2026-05',
        cuentas: instTrasReinicio.cuentas,
        categorias: instTrasReinicio.categorias,
        movimientos: instTrasReinicio.movimientos,
        presupuestos: instTrasReinicio.presupuestos,
      });
      // 2500 + 4800 + 3200 = 10500 céntimos (S/ 105.00); saldo = 200000 - 10500 = 189500 (S/ 1,895.00)
      expect(resumenOfflineTrasReinicio.egresosPeriodoCentimos).toBe(10_500);
      expect(resumenOfflineTrasReinicio.saldoRegistradoConocidoCentimos).toBe(189_500);

      // ==================== FASE E: CELULAR RECUPERA INTERNET MÓVIL (4G/5G) CON LA PC APAGADA ====================
      const clienteCelularTrasReinicio = new ClienteSupabasePrivado({
        url: urlSupabaseCloud,
        publishableKey: anonKeyValida,
        emailPropietarioAutorizado: emailPropietario,
      });
      // Simulamos que el accessToken expiró durante el viaje offline para probar la renovación automática por refresh_token
      clienteCelularTrasReinicio.restaurarSesion({
        ...estadoPersistidoTrasReinicio.sesionCloud!,
        expiraEnEpochSegundos: Math.floor(Date.now() / 1000) - 120,
      });

      const syncReconexionMovil = await repoCelularTrasReinicio.sincronizarConTransporte({
        transporte: clienteCelularTrasReinicio,
        propietarioId: propietarioUid,
        dispositivoId: instTrasReinicio.dispositivoId!,
      });

      expect(syncReconexionMovil.enviados).toBe(3);
      expect(syncReconexionMovil.conflictosDetectados).toBe(0);

      // Verificar que la cola local quedó limpia (0 pendientes) tras sincronizar con Supabase Cloud
      const instPostSyncMovil = await repoCelularTrasReinicio.obtenerInstantanea();
      expect(instPostSyncMovil.cambiosPendientesSync).toBe(0);

      // Reintento idempotente sobre red móvil inestable: volver a empujar los mismos sobres no duplica registros
      const sobresIdempotentes = (
        await clienteCelularTrasReinicio.descargarSobresDesde(propietarioUid, null)
      ).sobres.filter((s: SobreSincronizacion) =>
        [movOffline1.id, movOffline2.id, movOffline3.id].includes(s.id),
      );
      expect(sobresIdempotentes).toHaveLength(3);

      const reintentoPush = await clienteCelularTrasReinicio.empujarSobres(
        propietarioUid,
        sobresIdempotentes,
      );
      expect(reintentoPush.conflictos).toHaveLength(0);
      expect(reintentoPush.aplicados).toHaveLength(3);

      // Verificar en las tablas de Supabase Cloud que existen exactamente las 3 transacciones de gasto + 1 de saldo inicial (sin duplicados)
      const filasTransaccionesCloud = [
        ...(tablasCloud.get('transacciones_sync')?.values() ?? []),
      ];
      expect(filasTransaccionesCloud).toHaveLength(4);
      expect(urlsInvocadasPorCelular.length).toBeGreaterThan(0);

      repoCelularTrasReinicio.cerrar();
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});
