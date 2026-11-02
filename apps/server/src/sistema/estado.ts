/**
 * Estado de los datos: conteos por tabla (activos / eliminados) y por origen.
 * Permite comprobar en cualquier momento que la BD de producción solo
 * contiene lo que el usuario registró (y que empieza vacía).
 */
import type { DatabaseSync } from 'node:sqlite';
import { TABLAS_FINANCIERAS } from '../db/migraciones/index';
import { versionEsquema } from '../db/migrador';

export interface EstadoDatos {
  version_esquema: number;
  entorno: string | null;
  vacia: boolean;
  tablas: Record<string, { activos: number; eliminados: number }>;
  transacciones_por_origen: Record<string, number>;
  usuario_configurado: boolean;
}

export function estadoDatos(db: DatabaseSync): EstadoDatos {
  const tablas: EstadoDatos['tablas'] = {};
  let total = 0;
  for (const t of TABLAS_FINANCIERAS) {
    const f = db
      .prepare(`SELECT sum(eliminado_en IS NULL) AS activos, sum(eliminado_en IS NOT NULL) AS eliminados FROM ${t}`)
      .get() as { activos: number | null; eliminados: number | null };
    tablas[t] = { activos: f.activos ?? 0, eliminados: f.eliminados ?? 0 };
    total += (f.activos ?? 0) + (f.eliminados ?? 0);
  }
  const transacciones_por_origen: Record<string, number> = { MANUAL: 0, IMPORTADO: 0, SINCRONIZADO: 0 };
  for (const f of db.prepare('SELECT origen, count(*) AS n FROM transacciones GROUP BY origen').all() as {
    origen: string;
    n: number;
  }[]) {
    transacciones_por_origen[f.origen] = f.n;
  }
  const entorno = (db.prepare(`SELECT valor FROM metadatos WHERE clave = 'entorno'`).get() as { valor: string } | undefined)
    ?.valor ?? null;
  return {
    version_esquema: versionEsquema(db),
    entorno,
    vacia: total === 0,
    tablas,
    transacciones_por_origen,
    usuario_configurado: Boolean(db.prepare('SELECT 1 FROM usuario WHERE id = 1').get()),
  };
}
