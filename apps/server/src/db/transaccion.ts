import type { DatabaseSync } from 'node:sqlite';

/**
 * Ejecuta `fn` de forma atómica. Si ya hay una transacción abierta, usa un
 * SAVEPOINT anidado. Cualquier excepción revierte todos los cambios.
 */
export function enTransaccion<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const nombre = `sp_${Math.random().toString(36).slice(2, 10)}`;
    db.exec(`SAVEPOINT ${nombre}`);
    try {
      const r = fn();
      db.exec(`RELEASE ${nombre}`);
      return r;
    } catch (e) {
      db.exec(`ROLLBACK TO ${nombre}; RELEASE ${nombre}`);
      throw e;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
