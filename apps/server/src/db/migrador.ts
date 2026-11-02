/**
 * Migrador versionado.
 *  - Registra cada migración aplicada con su checksum SHA-256.
 *  - Aborta si una migración ya aplicada fue modificada, o si la BD tiene una
 *    versión más nueva que el código (evita corromper datos con código viejo).
 *  - Cada migración se aplica en su propia transacción (todo o nada).
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ahoraISO, MONEDA_PRINCIPAL, ZONA_HORARIA } from '@mis-cuentas/core';
import type { Entorno } from '../config';
import { MIGRACIONES, type Migracion } from './migraciones/index';
import { enTransaccion } from './transaccion';

export function checksumMigracion(m: Migracion): string {
  return createHash('sha256').update(m.sql, 'utf8').digest('hex');
}

function asegurarTablaMigraciones(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migraciones (
    version     INTEGER PRIMARY KEY,
    nombre      TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    aplicada_en TEXT NOT NULL
  ) STRICT`);
}

export function versionEsquema(db: DatabaseSync): number {
  const existe = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migraciones'`).get();
  if (!existe) return 0;
  const r = db.prepare(`SELECT coalesce(max(version), 0) AS v FROM _migraciones`).get() as { v: number };
  return r.v;
}

export function migracionesPendientes(db: DatabaseSync, lista: readonly Migracion[] = MIGRACIONES): Migracion[] {
  const actual = versionEsquema(db);
  return lista.filter((m) => m.version > actual);
}

export function validarMigracionesAplicadas(db: DatabaseSync, lista: readonly Migracion[] = MIGRACIONES): void {
  asegurarTablaMigraciones(db);
  const aplicadas = db.prepare(`SELECT version, nombre, checksum FROM _migraciones ORDER BY version`).all() as {
    version: number;
    nombre: string;
    checksum: string;
  }[];
  const maxConocida = lista.reduce((a, m) => Math.max(a, m.version), 0);
  for (const a of aplicadas) {
    if (a.version > maxConocida) {
      throw new Error(
        `La BD tiene la migración ${a.version} (${a.nombre}) pero este código solo conoce hasta la ${maxConocida}. Actualice la aplicación.`,
      );
    }
    const m = lista.find((x) => x.version === a.version);
    if (!m) throw new Error(`Migración aplicada ${a.version} no existe en el código`);
    if (checksumMigracion(m) !== a.checksum) {
      throw new Error(`La migración ${a.version} (${a.nombre}) fue modificada después de aplicarse. Operación abortada.`);
    }
  }
}

export function aplicarMigraciones(
  db: DatabaseSync,
  entorno: Entorno,
  lista: readonly Migracion[] = MIGRACIONES,
): { aplicadas: number[]; version: number } {
  validarMigracionesAplicadas(db, lista);
  const versiones = lista.map((m) => m.version);
  if (versiones.some((v, i) => v !== i + 1)) throw new Error('Las migraciones deben numerarse 1, 2, 3… sin huecos');

  const aplicadas: number[] = [];
  for (const m of migracionesPendientes(db, lista)) {
    enTransaccion(db, () => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO _migraciones (version, nombre, checksum, aplicada_en) VALUES (?, ?, ?, ?)`).run(
        m.version,
        m.nombre,
        checksumMigracion(m),
        ahoraISO(),
      );
      if (m.version === 1) {
        const ins = db.prepare(`INSERT INTO metadatos (clave, valor) VALUES (?, ?)`);
        ins.run('entorno', entorno);
        ins.run('creada_en', ahoraISO());
        ins.run('zona_horaria', ZONA_HORARIA);
        ins.run('moneda_principal', MONEDA_PRINCIPAL);
      }
    });
    aplicadas.push(m.version);
  }

  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length > 0) throw new Error(`Violaciones de clave foránea tras migrar: ${JSON.stringify(fk.slice(0, 5))}`);
  return { aplicadas, version: versionEsquema(db) };
}
