/**
 * Punto de entrada del servidor HTTP.
 *
 * Secuencia de arranque:
 *  1. Carga configuración y adquiere el bloqueo exclusivo sobre el directorio de datos.
 *  2. Inicializa la base de datos (guardias de entorno, backup pre-migración si aplica, migraciones y triggers de auditoría).
 *  3. Verifica la integridad financiera al inicio.
 *  4. Crea el backup automático diario si aún no existe para la fecha actual en Lima.
 *  5. Programa tareas periódicas (limpieza de sesiones vencidas y backup diario).
 *  6. Levanta el servidor Fastify y maneja el cierre ordenado (SIGINT/SIGTERM).
 */
import { limpiarSesionesVencidas } from './auth/usuario';
import { construirApp } from './api/app';
import { cargarConfig } from './config';
import { inicializarBaseDatos } from './db/inicializacion';
import { asegurarBackupDiario } from './sistema/backups';
import { adquirirBloqueo } from './sistema/bloqueo';
import { verificarIntegridad } from './sistema/integridad';

async function iniciar(): Promise<void> {
  const cfg = cargarConfig();
  const liberarBloqueo = adquirirBloqueo(cfg.rutaBloqueo);

  let cerrarRecursos = (): void => {
    liberarBloqueo();
  };

  try {
    const { db, version, migracionesAplicadas, backupPrevio } = await inicializarBaseDatos({
      ruta: cfg.rutaBaseDatos,
      entorno: cfg.entorno,
      directorioBackups: cfg.directorioBackups,
    });

    const integridad = verificarIntegridad(db);
    if (!integridad.ok) {
      db.close();
      liberarBloqueo();
      const fallos = integridad.comprobaciones.filter((c) => c.estado === 'ERROR').map((c) => c.codigo);
      throw new Error(`La verificación de integridad inicial falló (${fallos.join(', ')}). Revise con "npm run verificar".`);
    }

    const backupDiario = await asegurarBackupDiario(db, cfg.directorioBackups);

    const intervaloMantenimiento = setInterval(() => {
      try {
        limpiarSesionesVencidas(db, {
          duracionMs: cfg.sesionDuracionMs,
          inactividadMs: cfg.sesionInactividadMs,
        });
        void asegurarBackupDiario(db, cfg.directorioBackups);
      } catch (err) {
        console.error('[mantenimiento] Error en tarea periódica:', err);
      }
    }, 60 * 60 * 1000);
    intervaloMantenimiento.unref();

    const app = await construirApp({
      db,
      entorno: cfg.entorno,
      directorioBackups: cfg.directorioBackups,
      cookieSegura: cfg.cookieSegura,
      sesionDuracionMs: cfg.sesionDuracionMs,
      sesionInactividadMs: cfg.sesionInactividadMs,
      logger: true,
    });

    cerrarRecursos = (): void => {
      clearInterval(intervaloMantenimiento);
      void app.close().finally(() => {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          db.close();
        } finally {
          liberarBloqueo();
        }
      });
    };

    process.once('SIGINT', cerrarRecursos);
    process.once('SIGTERM', cerrarRecursos);

    await app.listen({ host: cfg.host, port: cfg.puerto });
    console.log(
      `[mis-cuentas] Servidor activo en http://${cfg.host}:${cfg.puerto} | entorno=${cfg.entorno} | esquema=v${version}` +
        (migracionesAplicadas.length ? ` (migraciones aplicadas: ${migracionesAplicadas.join(',')})` : '') +
        (backupPrevio ? ` | backup pre-migración: ${backupPrevio}` : '') +
        (backupDiario ? ` | backup diario: ${backupDiario.archivo}` : ''),
    );
  } catch (err) {
    cerrarRecursos();
    throw err;
  }
}

iniciar().catch((err) => {
  console.error('[mis-cuentas] Error fatal al iniciar:', err);
  process.exit(1);
});
