/**
 * Copias de seguridad.
 *
 *  - Usa la API de backup en caliente de SQLite (consistente aunque el servidor
 *    esté escribiendo).
 *  - Cada backup se verifica tras crearse (PRAGMA integrity_check) y se
 *    acompaña de un manifiesto JSON con SHA-256, versión de esquema y conteos.
 *  - Rotación conservadora: solo elimina copias AUTOMÁTICAS redundantes; las
 *    copias manuales y las previas a una restauración nunca se borran.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { ahoraISO, fechaContableDe, hoyLima, selloLimaCompacto } from '@mis-cuentas/core';
import { TABLAS_FINANCIERAS } from '../db/migraciones/index';

export const MOTIVOS_BACKUP = ['manual', 'diario', 'pre-migracion', 'pre-restauracion', 'pre-importacion'] as const;
export type MotivoBackup = (typeof MOTIVOS_BACKUP)[number];

export interface ManifiestoBackup {
  archivo: string;
  motivo: MotivoBackup;
  creado_en: string;
  sha256: string;
  tamano_bytes: number;
  version_esquema: number;
  entorno: string | null;
  conteos: Record<string, number>;
}

export interface InfoBackup extends ManifiestoBackup {
  ruta: string;
}

export function sha256Archivo(ruta: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(ruta, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Abre un archivo de BD en solo lectura y comprueba integridad. No aplica guardias de entorno: no escribe. */
export function inspeccionarArchivoBd(ruta: string): {
  integridad: string;
  version_esquema: number;
  entorno: string | null;
  conteos: Record<string, number>;
} {
  const db = new DatabaseSync(ruta, { readOnly: true });
  try {
    const integridad = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const tieneMig = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migraciones'`).get();
    const version = tieneMig
      ? (db.prepare('SELECT coalesce(max(version),0) AS v FROM _migraciones').get() as { v: number }).v
      : 0;
    const tieneMeta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadatos'`).get();
    const entorno = tieneMeta
      ? ((db.prepare(`SELECT valor FROM metadatos WHERE clave='entorno'`).get() as { valor: string } | undefined)?.valor ??
        null)
      : null;
    const conteos: Record<string, number> = {};
    for (const t of TABLAS_FINANCIERAS) {
      const existe = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (existe) conteos[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    return { integridad, version_esquema: version, entorno, conteos };
  } finally {
    db.close();
  }
}

function rutaDisponible(directorio: string, base: string): string {
  let ruta = path.join(directorio, `${base}.db`);
  for (let i = 2; fs.existsSync(ruta); i++) ruta = path.join(directorio, `${base}_${i}.db`);
  return ruta;
}

export async function crearBackup(
  db: DatabaseSync,
  opciones: { directorio: string; motivo: MotivoBackup; ahora?: Date },
): Promise<InfoBackup> {
  const ahora = opciones.ahora ?? new Date();
  fs.mkdirSync(opciones.directorio, { recursive: true });
  const ruta = rutaDisponible(opciones.directorio, `finanzas_${selloLimaCompacto(ahora)}_${opciones.motivo}`);
  const temporal = `${ruta}.parcial`;
  await backup(db, temporal);
  const info = inspeccionarArchivoBd(temporal);
  if (info.integridad !== 'ok') {
    fs.rmSync(temporal, { force: true });
    throw new Error(`El backup generado no pasó la verificación de integridad: ${info.integridad}`);
  }
  fs.renameSync(temporal, ruta);
  const manifiesto: ManifiestoBackup = {
    archivo: path.basename(ruta),
    motivo: opciones.motivo,
    creado_en: ahoraISO(ahora),
    sha256: sha256Archivo(ruta),
    tamano_bytes: fs.statSync(ruta).size,
    version_esquema: info.version_esquema,
    entorno: info.entorno,
    conteos: info.conteos,
  };
  fs.writeFileSync(`${ruta}.json`, JSON.stringify(manifiesto, null, 2), 'utf8');
  return { ...manifiesto, ruta };
}

export function listarBackups(directorio: string): InfoBackup[] {
  if (!fs.existsSync(directorio)) return [];
  const lista: InfoBackup[] = [];
  for (const nombre of fs.readdirSync(directorio)) {
    if (!nombre.endsWith('.db.json')) continue;
    const rutaManifiesto = path.join(directorio, nombre);
    try {
      const m = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf8')) as ManifiestoBackup;
      const ruta = path.join(directorio, m.archivo);
      if (fs.existsSync(ruta)) lista.push({ ...m, ruta });
    } catch {
      // Manifiesto ilegible: se ignora en el listado; `verificarBackup` lo reportará.
    }
  }
  return lista.sort((a, b) => (a.creado_en < b.creado_en ? 1 : a.creado_en > b.creado_en ? -1 : 0));
}

export interface ResultadoVerificacionBackup {
  ruta: string;
  valido: boolean;
  problemas: string[];
  manifiesto?: ManifiestoBackup;
}

export function verificarBackup(ruta: string): ResultadoVerificacionBackup {
  const problemas: string[] = [];
  if (!fs.existsSync(ruta)) return { ruta, valido: false, problemas: ['El archivo no existe'] };
  let manifiesto: ManifiestoBackup | undefined;
  const rutaManifiesto = `${ruta}.json`;
  if (fs.existsSync(rutaManifiesto)) {
    try {
      manifiesto = JSON.parse(fs.readFileSync(rutaManifiesto, 'utf8')) as ManifiestoBackup;
      if (sha256Archivo(ruta) !== manifiesto.sha256) problemas.push('El SHA-256 no coincide con el manifiesto (archivo alterado o dañado)');
    } catch {
      problemas.push('Manifiesto ilegible');
    }
  } else {
    problemas.push('Falta el manifiesto .json (no se puede comprobar el SHA-256)');
  }
  try {
    const info = inspeccionarArchivoBd(ruta);
    if (info.integridad !== 'ok') problemas.push(`integrity_check: ${info.integridad}`);
    if (info.version_esquema === 0) problemas.push('El archivo no contiene un esquema de esta aplicación');
  } catch (e) {
    problemas.push(`No se pudo abrir como BD SQLite: ${(e as Error).message}`);
  }
  return { ruta, valido: problemas.length === 0, problemas, ...(manifiesto ? { manifiesto } : {}) };
}

/** Política de retención (configurable). */
export interface PoliticaRetencion {
  /** Cantidad de backups diarios recientes a conservar. */
  diariosRecientes: number;
  /** Cantidad de backups pre-migración / pre-importación recientes a conservar (por motivo). */
  previosRecientes: number;
}
export const POLITICA_POR_DEFECTO: PoliticaRetencion = { diariosRecientes: 30, previosRecientes: 30 };

/**
 * Decide qué backups automáticos son redundantes. Función pura (probada).
 *  - 'manual' y 'pre-restauracion': nunca se eliminan.
 *  - 'diario': se conservan los N más recientes y, además, el primero de cada mes (para siempre).
 *  - 'pre-migracion' / 'pre-importacion': se conservan los N más recientes de cada motivo.
 */
export function seleccionarBackupsARotar(lista: readonly InfoBackup[], politica = POLITICA_POR_DEFECTO): InfoBackup[] {
  const eliminar: InfoBackup[] = [];
  const porFechaDesc = [...lista].sort((a, b) => (a.creado_en < b.creado_en ? 1 : -1));

  const diarios = porFechaDesc.filter((b) => b.motivo === 'diario');
  const primeroDelMes = new Map<string, InfoBackup>();
  for (const b of [...diarios].reverse()) {
    const mes = fechaContableDe(b.creado_en).slice(0, 7);
    if (!primeroDelMes.has(mes)) primeroDelMes.set(mes, b);
  }
  const conservarMensuales = new Set([...primeroDelMes.values()].map((b) => b.archivo));
  diarios.forEach((b, i) => {
    if (i >= politica.diariosRecientes && !conservarMensuales.has(b.archivo)) eliminar.push(b);
  });

  for (const motivo of ['pre-migracion', 'pre-importacion'] as const) {
    porFechaDesc
      .filter((b) => b.motivo === motivo)
      .forEach((b, i) => {
        if (i >= politica.previosRecientes) eliminar.push(b);
      });
  }
  return eliminar;
}

export function rotarBackups(directorio: string, politica = POLITICA_POR_DEFECTO): string[] {
  const eliminar = seleccionarBackupsARotar(listarBackups(directorio), politica);
  for (const b of eliminar) {
    fs.rmSync(b.ruta, { force: true });
    fs.rmSync(`${b.ruta}.json`, { force: true });
  }
  return eliminar.map((b) => b.archivo);
}

/** Crea el backup diario si aún no existe uno con la fecha de hoy (Lima). */
export async function asegurarBackupDiario(
  db: DatabaseSync,
  directorio: string,
  ahora: Date = new Date(),
): Promise<InfoBackup | null> {
  const hoy = hoyLima(ahora);
  const existe = listarBackups(directorio).some((b) => b.motivo === 'diario' && fechaContableDe(b.creado_en) === hoy);
  if (existe) return null;
  const info = await crearBackup(db, { directorio, motivo: 'diario', ahora });
  rotarBackups(directorio);
  return info;
}
