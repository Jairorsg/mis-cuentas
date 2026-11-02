/**
 * Restauración desde un backup.
 *
 * Pasos (abortan ante cualquier problema, sin tocar la BD actual):
 *  1. Verificar el backup (SHA-256 del manifiesto + integrity_check).
 *  2. Comprobar que pertenece al mismo entorno.
 *  3. Comprobar que el servidor no está en ejecución.
 *  4. Respaldar la BD actual ('pre-restauracion'), que nunca se rota.
 *  5. Copiar el backup a un temporal y reemplazar atómicamente la BD.
 *  6. Reabrir, aplicar migraciones pendientes y verificar integridad.
 */
import fs from 'node:fs';
import type { Entorno } from '../config';
import { abrirBaseDatos } from '../db/conexion';
import { inicializarBaseDatos } from '../db/inicializacion';
import { servidorActivo } from './bloqueo';
import { crearBackup, inspeccionarArchivoBd, verificarBackup } from './backups';
import { verificarIntegridad, type ReporteIntegridad } from './integridad';

export interface OpcionesRestauracion {
  rutaBackup: string;
  rutaBaseDatos: string;
  directorioBackups: string;
  rutaBloqueo: string;
  entorno: Entorno;
}

export interface ResultadoRestauracion {
  backupPrevio: string | null;
  version: number;
  integridad: ReporteIntegridad;
}

export async function restaurarBackup(op: OpcionesRestauracion): Promise<ResultadoRestauracion> {
  const verif = verificarBackup(op.rutaBackup);
  if (!verif.valido) throw new Error(`Backup no válido:\n - ${verif.problemas.join('\n - ')}`);

  const info = inspeccionarArchivoBd(op.rutaBackup);
  if (info.entorno !== op.entorno) {
    throw new Error(`El backup pertenece al entorno "${info.entorno}" y el destino es "${op.entorno}".`);
  }
  const pid = servidorActivo(op.rutaBloqueo);
  if (pid !== null) throw new Error(`Detenga el servidor (PID ${pid}) antes de restaurar.`);

  let backupPrevio: string | null = null;
  if (fs.existsSync(op.rutaBaseDatos)) {
    const actual = abrirBaseDatos({ ruta: op.rutaBaseDatos, entorno: op.entorno });
    try {
      backupPrevio = (await crearBackup(actual, { directorio: op.directorioBackups, motivo: 'pre-restauracion' })).ruta;
      actual.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      actual.close();
    }
  }

  const temporal = `${op.rutaBaseDatos}.restaurando`;
  fs.copyFileSync(op.rutaBackup, temporal);
  for (const sufijo of ['-wal', '-shm']) fs.rmSync(op.rutaBaseDatos + sufijo, { force: true });
  fs.renameSync(temporal, op.rutaBaseDatos);

  const { db, version } = await inicializarBaseDatos({
    ruta: op.rutaBaseDatos,
    entorno: op.entorno,
    directorioBackups: op.directorioBackups,
  });
  try {
    const integridad = verificarIntegridad(db);
    return { backupPrevio, version, integridad };
  } finally {
    db.close();
  }
}
