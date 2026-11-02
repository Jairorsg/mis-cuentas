/**
 * Punto único de apertura + preparación de la BD:
 *   guardias de entorno → verificación de entorno → backup pre-migración
 *   (si hay datos y migraciones pendientes) → migraciones → triggers de auditoría.
 */
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Entorno } from '../config';
import { crearBackup } from '../sistema/backups';
import { regenerarTriggersAuditoria } from './auditoria';
import { abrirBaseDatos, verificarEntornoBaseDatos } from './conexion';
import { aplicarMigraciones, migracionesPendientes, validarMigracionesAplicadas, versionEsquema } from './migrador';

export interface OpcionesInicializacion {
  ruta: string;
  entorno: Entorno;
  /** Directorio donde guardar el backup previo a migrar (obligatorio para BD en archivo). */
  directorioBackups?: string;
}

export interface BdInicializada {
  db: DatabaseSync;
  version: number;
  migracionesAplicadas: number[];
  backupPrevio: string | null;
}

export async function inicializarBaseDatos(op: OpcionesInicializacion): Promise<BdInicializada> {
  const existia = op.ruta !== ':memory:' && fs.existsSync(op.ruta);
  const db = abrirBaseDatos({ ruta: op.ruta, entorno: op.entorno });
  try {
    verificarEntornoBaseDatos(db, op.entorno);
    let backupPrevio: string | null = null;
    if (existia && versionEsquema(db) > 0) {
      validarMigracionesAplicadas(db);
      if (migracionesPendientes(db).length > 0) {
        if (!op.directorioBackups) throw new Error('Se requiere directorioBackups para migrar una BD existente');
        backupPrevio = (await crearBackup(db, { directorio: op.directorioBackups, motivo: 'pre-migracion' })).ruta;
      }
    }
    const { aplicadas, version } = aplicarMigraciones(db, op.entorno);
    regenerarTriggersAuditoria(db);
    return { db, version, migracionesAplicadas: aplicadas, backupPrevio };
  } catch (e) {
    db.close();
    throw e;
  }
}
