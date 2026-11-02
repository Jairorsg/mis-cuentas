/**
 * Auditoría y protección contra borrado físico.
 *
 * Los triggers se generan a partir de las columnas REALES de cada tabla, de
 * modo que si una migración futura agrega columnas, el historial las incluye
 * automáticamente. Como están en la BD, ningún camino del código (API, CLI,
 * importador) puede modificar datos sin dejar rastro.
 */
import type { DatabaseSync } from 'node:sqlite';
import { TABLAS_AUDITADAS } from './migraciones/index';
import { enTransaccion } from './transaccion';

const RE_IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(nombre: string): string {
  if (!RE_IDENT.test(nombre)) throw new Error(`Identificador SQL no permitido: ${nombre}`);
  return nombre;
}

function columnas(db: DatabaseSync, tabla: string): string[] {
  const filas = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(tabla) as { name: string }[];
  if (filas.length === 0) throw new Error(`La tabla auditada "${tabla}" no existe`);
  return filas.map((f) => ident(f.name));
}

const AHORA_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const CONTEXTO_SQL = `(SELECT valor FROM _contexto_auditoria WHERE id = 1)`;

function jsonFila(alias: 'NEW' | 'OLD', cols: string[]): string {
  return `json_object(${cols.map((c) => `'${c}', ${alias}.${c}`).join(', ')})`;
}

export function sqlTriggersAuditoria(tabla: string, clave: string, cols: string[]): string {
  const t = ident(tabla);
  const k = ident(clave);
  const tieneEliminado = cols.includes('eliminado_en');
  const accionUpd = tieneEliminado
    ? `CASE
         WHEN OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL THEN 'ELIMINACION_LOGICA'
         WHEN OLD.eliminado_en IS NOT NULL AND NEW.eliminado_en IS NULL THEN 'RESTAURACION'
         ELSE 'MODIFICACION' END`
    : `'MODIFICACION'`;
  const cambio = cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  return `
CREATE TRIGGER aud_${t}_ins AFTER INSERT ON ${t}
BEGIN
  INSERT INTO auditoria (tabla, registro_id, accion, antes, despues, contexto, ocurrido_en)
  VALUES ('${t}', NEW.${k}, 'CREACION', NULL, ${jsonFila('NEW', cols)}, ${CONTEXTO_SQL}, ${AHORA_SQL});
END;
CREATE TRIGGER aud_${t}_upd AFTER UPDATE ON ${t}
WHEN ${cambio}
BEGIN
  INSERT INTO auditoria (tabla, registro_id, accion, antes, despues, contexto, ocurrido_en)
  VALUES ('${t}', NEW.${k}, ${accionUpd}, ${jsonFila('OLD', cols)}, ${jsonFila('NEW', cols)}, ${CONTEXTO_SQL}, ${AHORA_SQL});
END;
CREATE TRIGGER prot_${t}_del BEFORE DELETE ON ${t}
WHEN NOT EXISTS (SELECT 1 FROM _permiso_purga WHERE tabla = '${t}' AND registro_id = OLD.${k})
BEGIN
  SELECT RAISE(ABORT, 'Eliminación física prohibida en ${t}: use eliminación lógica');
END;
CREATE TRIGGER aud_${t}_del AFTER DELETE ON ${t}
BEGIN
  INSERT INTO auditoria (tabla, registro_id, accion, antes, despues, contexto, ocurrido_en)
  VALUES ('${t}', OLD.${k}, 'PURGA', ${jsonFila('OLD', cols)}, NULL, ${CONTEXTO_SQL}, ${AHORA_SQL});
  DELETE FROM _permiso_purga WHERE tabla = '${t}' AND registro_id = OLD.${k};
END;
`;
}

/** Elimina y vuelve a crear todos los triggers de auditoría (idempotente). */
export function regenerarTriggersAuditoria(db: DatabaseSync): void {
  enTransaccion(db, () => {
    const existentes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'aud\\_%' ESCAPE '\\' OR name LIKE 'prot\\_%' ESCAPE '\\')`)
      .all() as { name: string }[];
    for (const { name } of existentes) db.exec(`DROP TRIGGER ${ident(name)}`);
    for (const { tabla, clave } of TABLAS_AUDITADAS) {
      db.exec(sqlTriggersAuditoria(tabla, clave, columnas(db, tabla)));
    }
  });
}

/**
 * Ejecuta `fn` dentro de una transacción, registrando `contexto` como autor de
 * los cambios en la auditoría (p. ej. "api", "cli:restaurar", "importacion:<lote>").
 */
export function conAuditoria<T>(db: DatabaseSync, contexto: string, fn: () => T): T {
  if (!contexto.trim()) throw new Error('El contexto de auditoría no puede estar vacío');
  return enTransaccion(db, () => {
    const fijar = db.prepare(`UPDATE _contexto_auditoria SET valor = ? WHERE id = 1`);
    fijar.run(contexto);
    try {
      return fn();
    } finally {
      fijar.run('sistema');
    }
  });
}

/**
 * Purga física de un registro (irreversible). Solo para uso explícito y
 * confirmado por el usuario; queda registrada en la auditoría con todo su
 * contenido previo.
 */
export function purgarRegistro(db: DatabaseSync, tabla: string, registroId: string, contexto: string): void {
  const def = TABLAS_AUDITADAS.find((t) => t.tabla === tabla);
  if (!def) throw new Error(`Tabla no purgable: ${tabla}`);
  conAuditoria(db, contexto, () => {
    db.prepare(`INSERT INTO _permiso_purga (tabla, registro_id) VALUES (?, ?)`).run(tabla, registroId);
    const r = db.prepare(`DELETE FROM ${ident(def.tabla)} WHERE ${ident(def.clave)} = ?`).run(registroId);
    if (Number(r.changes) === 0) throw new Error(`No existe ${tabla}/${registroId}`);
  });
}
