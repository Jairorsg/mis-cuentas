/**
 * Exportación completa a JSON (portabilidad y respaldo legible).
 * Incluye registros eliminados lógicamente y la auditoría completa.
 * Excluye credenciales (hash de contraseña) y sesiones.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ahoraISO, selloLimaCompacto } from '@mis-cuentas/core';
import { TABLAS_AUDITADAS } from '../db/migraciones/index';
import { versionEsquema } from '../db/migrador';

export interface Exportacion {
  formato: 'mis-cuentas/exportacion';
  version_formato: 1;
  exportado_en: string;
  version_esquema: number;
  metadatos: Record<string, string>;
  tablas: Record<string, Record<string, unknown>[]>;
}

export function construirExportacion(db: DatabaseSync): Exportacion {
  const metadatos: Record<string, string> = {};
  for (const f of db.prepare('SELECT clave, valor FROM metadatos').all() as { clave: string; valor: string }[]) {
    metadatos[f.clave] = f.valor;
  }
  const tablas: Record<string, Record<string, unknown>[]> = {};
  for (const { tabla, clave } of TABLAS_AUDITADAS) {
    tablas[tabla] = (db.prepare(`SELECT * FROM ${tabla} ORDER BY ${clave}`).all() as Record<string, unknown>[]).map(
      (f) => ({ ...f }),
    );
  }
  tablas['auditoria'] = (db.prepare('SELECT * FROM auditoria ORDER BY id').all() as Record<string, unknown>[]).map((f) => ({
    ...f,
  }));
  tablas['_migraciones'] = (db.prepare('SELECT * FROM _migraciones ORDER BY version').all() as Record<string, unknown>[]).map(
    (f) => ({ ...f }),
  );
  return {
    formato: 'mis-cuentas/exportacion',
    version_formato: 1,
    exportado_en: ahoraISO(),
    version_esquema: versionEsquema(db),
    metadatos,
    tablas,
  };
}

export function exportarAArchivo(db: DatabaseSync, directorio: string): { ruta: string; sha256: string } {
  fs.mkdirSync(directorio, { recursive: true });
  const ruta = path.join(directorio, `exportacion_${selloLimaCompacto()}.json`);
  const contenido = JSON.stringify(construirExportacion(db), null, 2);
  fs.writeFileSync(ruta, contenido, 'utf8');
  const sha256 = createHash('sha256').update(contenido, 'utf8').digest('hex');
  fs.writeFileSync(`${ruta}.sha256`, `${sha256}  ${path.basename(ruta)}\n`, 'utf8');
  return { ruta, sha256 };
}
