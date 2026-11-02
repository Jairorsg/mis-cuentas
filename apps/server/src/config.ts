/**
 * Configuración del servidor.
 *
 * Entornos:
 *  - production : datos reales del usuario  → <repo>/data
 *  - development: desarrollo local           → <repo>/data-dev (BD independiente)
 *  - test       : SOLO ':memory:' o archivos en el directorio temporal del SO
 *
 * Prioridad: argumento --entorno=… > variable APP_ENV > 'production'.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ENTORNOS = ['production', 'development', 'test'] as const;
export type Entorno = (typeof ENTORNOS)[number];

export const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface Config {
  entorno: Entorno;
  directorioDatos: string;
  rutaBaseDatos: string;
  directorioBackups: string;
  directorioExportaciones: string;
  rutaBloqueo: string;
  host: string;
  puerto: number;
  cookieSegura: boolean;
  /** Duración absoluta de una sesión. */
  sesionDuracionMs: number;
  /** Cierre por inactividad. */
  sesionInactividadMs: number;
}

const esquemaEntorno = z.object({
  APP_ENV: z.enum(ENTORNOS).optional(),
  DATA_DIR: z.string().min(1).optional(),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
});

export function leerEntornoDeArgs(argv: readonly string[]): Entorno | undefined {
  const arg = argv.find((a) => a.startsWith('--entorno='));
  if (!arg) return undefined;
  const valor = arg.slice('--entorno='.length);
  const r = z.enum(ENTORNOS).safeParse(valor);
  if (!r.success) throw new Error(`--entorno inválido: "${valor}". Use: ${ENTORNOS.join(', ')}`);
  return r.data;
}

export function cargarConfig(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const e = esquemaEntorno.parse(env);
  const entorno: Entorno = leerEntornoDeArgs(argv) ?? e.APP_ENV ?? 'production';
  if (entorno === 'test') {
    throw new Error('El entorno "test" solo se usa desde las pruebas automatizadas, no desde el servidor ni la CLI.');
  }
  const porDefecto = entorno === 'production' ? 'data' : 'data-dev';
  const directorioDatos = path.resolve(RAIZ_REPO, e.DATA_DIR ?? porDefecto);
  return {
    entorno,
    directorioDatos,
    rutaBaseDatos: path.join(directorioDatos, 'finanzas.db'),
    directorioBackups: path.join(directorioDatos, 'backups'),
    directorioExportaciones: path.join(directorioDatos, 'exportaciones'),
    rutaBloqueo: path.join(directorioDatos, 'servidor.lock'),
    host: e.HOST ?? '127.0.0.1',
    puerto: e.PORT ?? (entorno === 'production' ? 4300 : 4301),
    cookieSegura: e.COOKIE_SECURE === 'true',
    sesionDuracionMs: 30 * 24 * 3600 * 1000,
    sesionInactividadMs: 7 * 24 * 3600 * 1000,
  };
}
