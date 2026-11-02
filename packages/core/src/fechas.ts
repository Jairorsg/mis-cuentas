/**
 * Fechas y zona horaria.
 *
 * Convención de almacenamiento:
 *  - Instantes (creado_en, actualizado_en, instante de una operación): ISO-8601
 *    en UTC con milisegundos, p. ej. "2026-11-01T21:00:00.000Z".
 *  - Fecha contable de un movimiento: "YYYY-MM-DD" interpretada en
 *    America/Lima. Todos los cortes por día/mes/año usan la fecha contable.
 *
 * Se usa Intl (base de datos IANA) en lugar de un desfase fijo −05:00 para que
 * el cálculo sea correcto incluso si Perú volviera a adoptar horario de verano.
 */
export const ZONA_HORARIA = 'America/Lima' as const;

const formateadorFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const formateadorFechaHora = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partes(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const r: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) r[p.type] = p.value;
  return r;
}

function aDate(instante: Date | string): Date {
  const d = typeof instante === 'string' ? new Date(instante) : instante;
  if (Number.isNaN(d.getTime())) throw new Error(`Instante inválido: ${String(instante)}`);
  return d;
}

/** Instante actual en ISO-8601 UTC. */
export function ahoraISO(ahora: Date = new Date()): string {
  return ahora.toISOString();
}

/** Fecha contable (America/Lima) de un instante. */
export function fechaContableDe(instante: Date | string): string {
  const p = partes(formateadorFecha, aDate(instante));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Fecha de hoy en Lima. */
export function hoyLima(ahora: Date = new Date()): string {
  return fechaContableDe(ahora);
}

/** Sello compacto en hora de Lima para nombres de archivo: "20261101-160000". */
export function selloLimaCompacto(ahora: Date = new Date()): string {
  const p = partes(formateadorFechaHora, ahora);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

/** Fecha y hora legible en Lima: "2026-11-01 16:00:00". */
export function fechaHoraLima(instante: Date | string): string {
  const p = partes(formateadorFechaHora, aDate(instante));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** true si es "YYYY-MM-DD" y corresponde a un día real del calendario. */
export function esFechaContableValida(fecha: string): boolean {
  const m = RE_FECHA.exec(fecha);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function assertFecha(fecha: string): [number, number, number] {
  if (!esFechaContableValida(fecha)) throw new Error(`Fecha contable inválida: "${fecha}"`);
  const [y, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function formatearUTC(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

/** Suma (o resta) días a una fecha contable. */
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = assertFecha(fecha);
  return formatearUTC(new Date(Date.UTC(y, m - 1, d + dias)));
}

export function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/** "2026-11-15" → "2026-11". */
export function mesDe(fecha: string): string {
  assertFecha(fecha);
  return fecha.slice(0, 7);
}

export function inicioDeMes(fecha: string): string {
  const [y, m] = assertFecha(fecha);
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

export function finDeMes(fecha: string): string {
  const [y, m] = assertFecha(fecha);
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(diasEnMes(y, m)).padStart(2, '0')}`;
}

/** Número de días entre dos fechas contables (b − a). */
export function diferenciaDias(a: string, b: string): number {
  const [ya, ma, da] = assertFecha(a);
  const [yb, mb, db] = assertFecha(b);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}
