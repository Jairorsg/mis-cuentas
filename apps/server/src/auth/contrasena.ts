/**
 * Hash de contraseñas con scrypt (incluido en Node, sin dependencias nativas).
 * Formato almacenado: scrypt$N$r$p$<sal base64>$<hash base64>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const LARGO = 64;
const MAXMEM = 128 * N * R * 2;

export const LONGITUD_MINIMA_CONTRASENA = 12;

function scrypt(clave: string, sal: Buffer, largo: number, opciones: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(clave.normalize('NFKC'), sal, largo, opciones, (err, derivada) => (err ? reject(err) : resolve(derivada)));
  });
}

export function validarFortaleza(contrasena: string): string | null {
  if (contrasena.length < LONGITUD_MINIMA_CONTRASENA) {
    return `La contraseña debe tener al menos ${LONGITUD_MINIMA_CONTRASENA} caracteres`;
  }
  if (contrasena.trim() !== contrasena) return 'La contraseña no debe empezar ni terminar con espacios';
  return null;
}

export async function hashContrasena(contrasena: string): Promise<string> {
  const sal = randomBytes(16);
  const h = await scrypt(contrasena, sal, LARGO, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

export async function verificarContrasena(contrasena: string, almacenado: string): Promise<boolean> {
  const partes = almacenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, salB64, hashB64] = partes as [string, string, string, string, string, string];
  const esperado = Buffer.from(hashB64, 'base64');
  const obtenido = await scrypt(contrasena, Buffer.from(salB64, 'base64'), esperado.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return obtenido.length === esperado.length && timingSafeEqual(obtenido, esperado);
}

/** Hash de referencia para igualar el tiempo de respuesta cuando no existe usuario. */
let hashFicticioCache: Promise<string> | null = null;
export function hashParaTiempoConstante(): Promise<string> {
  hashFicticioCache ??= hashContrasena(randomBytes(24).toString('base64'));
  return hashFicticioCache;
}
