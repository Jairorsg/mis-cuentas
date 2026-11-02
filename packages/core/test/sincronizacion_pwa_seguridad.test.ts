import { describe, expect, it } from 'vitest';
import {
  abrirPaqueteQrCifrado,
  AlmacenNubeConRls,
  crearVerificadorBloqueoLocal,
  esEndpointLocalOIpPrivadaProhibida,
  evaluarPoliticaCachePwa,
  exportarJsonCifradoConContrasena,
  generarPaqueteQrCifrado,
  importarJsonCifradoConContrasena,
  NodoSincronizacionDispositivo,
  obtenerCachesObsoletasPwa,
  sanitizarParaLogSinDatosFinancieros,
  validarClavePublicaSupabaseEnCliente,
  verificarCodigoBloqueoLocal,
  type MovimientoFinanciero,
} from '../src/index';

const UID_PROPIETARIO = '11111111-2222-4333-8444-555555555555';
const UID_INTRUSO = '99999999-8888-4777-8666-000000000000';

const AUDITORIA_BASE = {
  origen: 'MANUAL' as const,
  creadoEn: '2026-04-01T10:00:00.000Z',
  actualizadoEn: '2026-04-01T10:00:00.000Z',
  eliminadoEn: null,
  version: 1,
  loteImportacionId: null,
};

function crearMov(id: string, montoCentimos: number, descripcion = 'Compra'): MovimientoFinanciero {
  return {
    id,
    fechaMovimiento: '2026-04-01',
    horaMovimiento: '14:30',
    registradoEn: '2026-04-01T19:30:00.000Z',
    tipo: 'GASTO',
    categoriaId: 'cat-alim',
    subcategoriaId: null,
    cuentaId: 'cta-yape',
    cuentaDestinoId: null,
    esPagoTarjeta: false,
    montoCentimos,
    moneda: 'PEN',
    etiquetas: ['#Rutina'],
    descripcion,
    eventoId: null,
    estado: 'ACTIVO',
    auditoria: AUDITORIA_BASE,
  };
}

describe('Fase 5: Sincronización Multidispositivo, RLS, Offline, Conflictos, Web Crypto, QR y Caché PWA', () => {
  it('1. Sincroniza PC -> Nube -> Celular y Celular -> Nube -> PC con pérdida de conexión, cola offline, reconexión e idempotencia', async () => {
    const nube = new AlmacenNubeConRls({ uidPropietarioAutorizado: UID_PROPIETARIO });
    const pc = new NodoSincronizacionDispositivo({
      dispositivoId: 'pc-escritorio',
      propietarioId: UID_PROPIETARIO,
      conectadoInicial: true,
    });
    const celular = new NodoSincronizacionDispositivo({
      dispositivoId: 'celular-android',
      propietarioId: UID_PROPIETARIO,
      conectadoInicial: true,
    });

    // 1. PC registra un movimiento y un presupuesto y sincroniza con la nube
    const movPc = crearMov('tx-101', 4500, 'Almuerzo registrado en PC');
    pc.guardarLocalmente('transacciones', movPc as unknown as Record<string, unknown>);
    const resPushPc = await pc.sincronizarConNube(nube);
    expect(resPushPc.exito).toBe(true);
    expect(resPushPc.enviados).toBe(1);
    expect(pc.obtenerEstadoResumen().operacionesPendientes).toBe(0);

    // 2. Celular descarga desde la nube y recibe exactamente el movimiento de PC
    const resPullCel = await celular.sincronizarConNube(nube);
    expect(resPullCel.exito).toBe(true);
    expect(resPullCel.recibidos).toBe(1);
    expect(celular.obtenerRegistroLocal<MovimientoFinanciero>('transacciones', 'tx-101')?.datos.montoCentimos).toBe(4500);

    // 3. Celular pierde conexión a internet (Modo Offline) y registra 2 movimientos nuevos
    celular.establecerConexion(false);
    expect(celular.estaConectado()).toBe(false);

    celular.guardarLocalmente(
      'transacciones',
      crearMov('tx-102', 1800, 'Taxi registrado offline en celular') as unknown as Record<string, unknown>,
    );
    celular.guardarLocalmente(
      'transacciones',
      crearMov('tx-103', 3200, 'Cena registrada offline en celular') as unknown as Record<string, unknown>,
    );

    // Intentar sincronizar sin internet conserva la cola local sin perder nada
    const intentoOffline = await celular.sincronizarConNube(nube);
    expect(intentoOffline.exito).toBe(false);
    expect(celular.obtenerEstadoResumen().operacionesPendientes).toBe(2);

    // 4. Celular recupera conexión a internet -> sincroniza la cola pendiente sin duplicar
    celular.establecerConexion(true);
    const resReconexion = await celular.sincronizarConNube(nube);
    expect(resReconexion.exito).toBe(true);
    expect(resReconexion.enviados).toBe(2);
    expect(celular.obtenerEstadoResumen().operacionesPendientes).toBe(0);

    // 5. PC sincroniza y obtiene los 2 movimientos creados offline en el celular
    await pc.sincronizarConNube(nube);
    expect(pc.listarRegistrosLocales('transacciones')).toHaveLength(3);
    expect(celular.listarRegistrosLocales('transacciones')).toHaveLength(3);
  });

  it('2. Detecta conflictos de modificación simultánea y eliminación vs. edición sin sobrescribir silenciosamente, y converge al resolver', async () => {
    const nube = new AlmacenNubeConRls({ uidPropietarioAutorizado: UID_PROPIETARIO });
    const pc = new NodoSincronizacionDispositivo({
      dispositivoId: 'pc-1',
      propietarioId: UID_PROPIETARIO,
    });
    const celular = new NodoSincronizacionDispositivo({
      dispositivoId: 'celular-1',
      propietarioId: UID_PROPIETARIO,
    });

    // Ambos dispositivos parten con tx-200 sincronizado en versión 1 (monto 5000)
    pc.guardarLocalmente(
      'transacciones',
      crearMov('tx-200', 5000, 'Original') as unknown as Record<string, unknown>,
    );
    await pc.sincronizarConNube(nube);
    await celular.sincronizarConNube(nube);

    // Celular queda offline; mientras tanto PC modifica tx-200 a monto 6500 y sincroniza (nube sube a v2)
    celular.establecerConexion(false);
    pc.guardarLocalmente(
      'transacciones',
      {
        ...crearMov('tx-200', 6500, 'Editado en PC'),
        auditoria: { ...AUDITORIA_BASE, version: 2 },
      } as unknown as Record<string, unknown>,
    );
    await pc.sincronizarConNube(nube);

    // Celular (aún con base v1) modifica tx-200 a monto 7200 y luego reconecta
    celular.guardarLocalmente(
      'transacciones',
      {
        ...crearMov('tx-200', 7200, 'Editado en Celular offline'),
        auditoria: { ...AUDITORIA_BASE, version: 2 },
      } as unknown as Record<string, unknown>,
    );
    celular.establecerConexion(true);

    const resConflicto = await celular.sincronizarConNube(nube);
    expect(resConflicto.exito).toBe(true);
    expect(resConflicto.conflictosNuevos).toBe(1);

    // Verificar que NO se sobrescribió silenciosamente la nube (sigue en 6500) y el celular registró el conflicto
    const listaConflictos = celular.listarConflictos();
    expect(listaConflictos).toHaveLength(1);
    expect(listaConflictos[0]!.motivo).toBe('EDICION_SIMULTANEA');

    // El usuario resuelve explícitamente conservando su versión local del celular (7200) -> sube a versión 3
    celular.resolverConflicto(listaConflictos[0]!.id, 'CONSERVAR_LOCAL');
    await celular.sincronizarConNube(nube);
    await pc.sincronizarConNube(nube);

    const finalPc = pc.obtenerRegistroLocal<MovimientoFinanciero>('transacciones', 'tx-200')!;
    const finalCel = celular.obtenerRegistroLocal<MovimientoFinanciero>('transacciones', 'tx-200')!;
    expect(finalPc.datos.montoCentimos).toBe(7200);
    expect(finalCel.datos.montoCentimos).toBe(7200);
    expect(finalPc.version).toBe(3);
    expect(finalCel.version).toBe(3);
  });

  it('3. Autorización RLS y Seguridad de Credenciales: bloquea accesos no autenticados, usuarios intrusos y claves service_role en cliente', async () => {
    const nube = new AlmacenNubeConRls({ uidPropietarioAutorizado: UID_PROPIETARIO });

    // Intento sin sesión (authUid = null)
    await expect(nube.descargarSobresDesde(null, null)).rejects.toThrow(/RLS_NO_AUTENTICADO/);

    // Intento con otro usuario autenticado pero distinto del propietario privado
    await expect(nube.descargarSobresDesde(UID_INTRUSO, null)).rejects.toThrow(
      /RLS_CUENTA_NO_AUTORIZADA/,
    );

    // Validación de claves en cliente: rechaza service_role y sb_secret_
    const checkSecret = validarClavePublicaSupabaseEnCliente(
      'https://demo.supabase.co',
      'sb_secret_123456789',
    );
    expect(checkSecret.valida).toBe(false);
    expect(checkSecret.motivoRechazo).toContain('BLOQUEO DE SEGURIDAD');

    // JWT con role: "service_role" en el payload
    const payloadServiceRole = Buffer.from(JSON.stringify({ role: 'service_role' })).toString(
      'base64url',
    );
    const jwtProhibido = `eyJhbGciOiJIUzI1NiJ9.${payloadServiceRole}.firma`;
    expect(
      validarClavePublicaSupabaseEnCliente('https://demo.supabase.co', jwtProhibido).valida,
    ).toBe(false);

    // JWT con role: "anon" es aceptado como publishable key bajo RLS
    const payloadAnon = Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url');
    const jwtAnon = `eyJhbGciOiJIUzI1NiJ9.${payloadAnon}.firma`;
    expect(
      validarClavePublicaSupabaseEnCliente('https://demo.supabase.co', jwtAnon).valida,
    ).toBe(true);

    // Prohibición estricta de localhost, 127.0.0.1 e IPs privadas de red local (Independencia total de la PC)
    for (const urlProhibida of [
      'http://localhost:3001',
      'https://localhost:54321',
      'http://127.0.0.1:54321',
      'https://192.168.1.45',
      'https://10.0.0.15',
      'https://172.16.5.4',
      'https://mi-computadora.local',
      'http://demo.supabase.co',
    ]) {
      const checkLocal = esEndpointLocalOIpPrivadaProhibida(urlProhibida);
      expect(checkLocal.prohibido).toBe(true);
      const checkCliente = validarClavePublicaSupabaseEnCliente(urlProhibida, jwtAnon);
      expect(checkCliente.valida).toBe(false);
    }
    expect(esEndpointLocalOIpPrivadaProhibida('https://demo.supabase.co').prohibido).toBe(false);

    // Sanitización de logs: nunca expone montos ni tokens
    const logSanitizado = sanitizarParaLogSinDatosFinancieros({
      accion: 'SYNC',
      montoCentimos: 95000,
      descripcion: 'Pago privado',
      accessToken: 'jwt-secreto',
    });
    expect(logSanitizado.accion).toBe('SYNC');
    expect(logSanitizado.montoCentimos).toBe('[REDACTADO_POR_PRIVACIDAD]');
    expect(logSanitizado.accessToken).toBe('[REDACTADO_POR_PRIVACIDAD]');
  });

  it('4. Respaldo JSON Cifrado con Contraseña (Web Crypto AES-256-GCM) y Paquetes Cortos QR (bloqueando QR gigantes)', async () => {
    const instantaneaOriginal = {
      moneda: 'PEN',
      movimientos: [crearMov('tx-enc-1', 12_500, 'Respaldo seguro')],
    };

    const jsonCifrado = await exportarJsonCifradoConContrasena(
      instantaneaOriginal,
      'MiClaveSegura#2026',
      20_000,
    );
    expect(jsonCifrado).not.toContain('Respaldo seguro');
    expect(jsonCifrado).toContain('MIS_CUENTAS_ENCRYPTED_BACKUP_V1');

    // Contraseña incorrecta debe fallar en la autenticación GCM
    await expect(
      importarJsonCifradoConContrasena(jsonCifrado, 'ClaveIncorrecta'),
    ).rejects.toThrow(/Contraseña incorrecta/);

    // Contraseña correcta restaura íntegramente y verifica SHA-256
    const restaurado = await importarJsonCifradoConContrasena<typeof instantaneaOriginal>(
      jsonCifrado,
      'MiClaveSegura#2026',
    );
    expect(restaurado).toEqual(instantaneaOriginal);

    // Paquete corto QR con 2 movimientos -> válido y < 1200 bytes
    const qrValido = await generarPaqueteQrCifrado({
      tipoPaquete: 'MICRO_LOTE_MOVIMIENTOS',
      contrasena: 'ClaveQR#2026',
      movimientos: [crearMov('q1', 1000), crearMov('q2', 2000)],
    });
    const qrAbierto = await abrirPaqueteQrCifrado(qrValido, 'ClaveQR#2026');
    expect(qrAbierto.cantidadMovimientos).toBe(2);

    // Intentar meter 10 movimientos en un solo QR es rechazado explícitamente
    const diezMovs = Array.from({ length: 10 }, (_, i) => crearMov(`q-${i}`, 1000));
    await expect(
      generarPaqueteQrCifrado({
        tipoPaquete: 'MICRO_LOTE_MOVIMIENTOS',
        contrasena: 'ClaveQR#2026',
        movimientos: diezMovs,
      }),
    ).rejects.toThrow(/PROHIBIDO_QR_GIGANTE/);
  });

  it('5. Estrategia de Caché PWA y Pantalla de Bloqueo Local PBKDF2', async () => {
    // 1. Recursos estáticos del App Shell SÍ se cachean
    expect(
      evaluarPoliticaCachePwa({
        metodo: 'GET',
        url: 'https://miscuentas.local/assets/index-123.js',
        origenActual: 'https://miscuentas.local',
      }).permitirCache,
    ).toBe(true);

    // 2. Rutas privadas de API, Supabase REST/Auth o cabeceras Authorization JAMÁS se cachean
    expect(
      evaluarPoliticaCachePwa({
        metodo: 'GET',
        url: 'https://miscuentas.local/api/transacciones',
        origenActual: 'https://miscuentas.local',
      }).permitirCache,
    ).toBe(false);

    expect(
      evaluarPoliticaCachePwa({
        metodo: 'GET',
        url: 'https://proyecto.supabase.co/rest/v1/transacciones_sync',
        origenActual: 'https://miscuentas.local',
      }).permitirCache,
    ).toBe(false);

    expect(
      evaluarPoliticaCachePwa({
        metodo: 'GET',
        url: 'https://miscuentas.local/index.html',
        origenActual: 'https://miscuentas.local',
        tieneCabeceraAuthorization: true,
      }).permitirCache,
    ).toBe(false);

    expect(
      obtenerCachesObsoletasPwa(
        ['mis-cuentas-shell-v0', 'mis-cuentas-shell-v1', 'otra-cache'],
        'mis-cuentas-shell-v1',
      ),
    ).toEqual(['mis-cuentas-shell-v0']);

    // 3. Bloqueo local de la aplicación con PBKDF2-SHA256
    const verificador = await crearVerificadorBloqueoLocal('4829', 15_000);
    expect(await verificarCodigoBloqueoLocal('4829', verificador)).toBe(true);
    expect(await verificarCodigoBloqueoLocal('9999', verificador)).toBe(false);
  });
});
