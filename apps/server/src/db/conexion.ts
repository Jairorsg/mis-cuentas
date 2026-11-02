/**
 * Apertura de la base de datos con guardias de entorno.
 *
 * Guardias (regla: los datos de prueba nunca tocan la cuenta real):
 *  1. En entorno 'test' solo se aceptan ':memory:' o archivos dentro del
 *     directorio temporal del sistema operativo.
 *  2. Fuera de 'test' se rechaza ':memory:' (evita perder datos reales sin aviso)
 *     y se rechaza cualquier apertura si el proceso corre bajo Vitest.
 *  3. Cada BD registra en `metadatos.entorno` para qué entorno fue creada; abrirla
 *     desde otro entorno aborta (ver verificarEntornoBaseDatos).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entorno } from '../config';

export class ErrorGuardiaEntorno extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorGuardiaEntorno';
  }
}

function dentroDe(dir: string, ruta: string): boolean {
  const rel = path.relative(fs.realpathSync.native(dir), ruta);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function rutaReal(ruta: string): string {
  const abs = path.resolve(ruta);
  const dir = path.dirname(abs);
  const dirReal = fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir;
  return path.join(dirReal, path.basename(abs));
}

export function validarRutaParaEntorno(ruta: string, entorno: Entorno, env: NodeJS.ProcessEnv = process.env): void {
  const enVitest = env.VITEST !== undefined;
  if (entorno === 'test') {
    if (ruta === ':memory:') return;
    if (!dentroDe(os.tmpdir(), rutaReal(ruta))) {
      throw new ErrorGuardiaEntorno(`En pruebas solo se permiten BD en memoria o en ${os.tmpdir()}; se intentó abrir ${ruta}`);
    }
    return;
  }
  if (enVitest) {
    throw new ErrorGuardiaEntorno(`Las pruebas automatizadas no pueden abrir una BD del entorno "${entorno}"`);
  }
  if (ruta === ':memory:') {
    throw new ErrorGuardiaEntorno(`El entorno "${entorno}" requiere una BD en archivo (persistente)`);
  }
}

export interface OpcionesApertura {
  ruta: string;
  entorno: Entorno;
  soloLectura?: boolean;
}

export function abrirBaseDatos({ ruta, entorno, soloLectura = false }: OpcionesApertura): DatabaseSync {
  validarRutaParaEntorno(ruta, entorno);
  if (ruta !== ':memory:' && !soloLectura) fs.mkdirSync(path.dirname(path.resolve(ruta)), { recursive: true });
  const db = new DatabaseSync(ruta, {
    readOnly: soloLectura,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (!soloLectura && ruta !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // Durabilidad máxima: cada COMMIT se sincroniza a disco.
    db.exec('PRAGMA synchronous = FULL');
  }
  db.exec('PRAGMA trusted_schema = OFF');
  return db;
}

/** Comprueba que la BD fue creada para este entorno. */
export function verificarEntornoBaseDatos(db: DatabaseSync, entorno: Entorno): void {
  const existe = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadatos'`).get();
  if (!existe) return; // BD nueva: el migrador registrará el entorno.
  const fila = db.prepare(`SELECT valor FROM metadatos WHERE clave = 'entorno'`).get() as { valor: string } | undefined;
  if (fila && fila.valor !== entorno) {
    throw new ErrorGuardiaEntorno(
      `Esta BD pertenece al entorno "${fila.valor}" y se intentó abrir como "${entorno}". Operación abortada.`,
    );
  }
}
