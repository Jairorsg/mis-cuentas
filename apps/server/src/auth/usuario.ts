/**
 * Usuario único y sesiones.
 *
 * - Hay un solo usuario (id = 1). Se crea desde la CLI, nunca por la API, para
 *   que nadie en la red pueda "reclamar" la instalación.
 * - Las sesiones guardan solo el SHA-256 del token; el token viaja en una cookie
 *   httpOnly + SameSite=Strict.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ahoraISO } from '@mis-cuentas/core';
import { enTransaccion } from '../db/transaccion';
import { hashContrasena, hashParaTiempoConstante, validarFortaleza, verificarContrasena } from './contrasena';

export interface Usuario {
  nombre: string;
}

export function obtenerUsuario(db: DatabaseSync): Usuario | null {
  const f = db.prepare('SELECT nombre FROM usuario WHERE id = 1').get() as { nombre: string } | undefined;
  return f ? { nombre: f.nombre } : null;
}

export async function crearUsuario(db: DatabaseSync, nombre: string, contrasena: string): Promise<void> {
  if (obtenerUsuario(db)) throw new Error('El usuario ya existe. Use la opción de cambio de contraseña.');
  if (!nombre.trim()) throw new Error('El nombre de usuario no puede estar vacío');
  const error = validarFortaleza(contrasena);
  if (error) throw new Error(error);
  const hash = await hashContrasena(contrasena);
  const ahora = ahoraISO();
  db.prepare('INSERT INTO usuario (id, nombre, hash_contrasena, creado_en, actualizado_en) VALUES (1, ?, ?, ?, ?)').run(
    nombre.trim(),
    hash,
    ahora,
    ahora,
  );
}

export async function cambiarContrasena(db: DatabaseSync, nueva: string): Promise<void> {
  if (!obtenerUsuario(db)) throw new Error('No existe usuario');
  const error = validarFortaleza(nueva);
  if (error) throw new Error(error);
  const hash = await hashContrasena(nueva);
  enTransaccion(db, () => {
    db.prepare('UPDATE usuario SET hash_contrasena = ?, actualizado_en = ? WHERE id = 1').run(hash, ahoraISO());
    db.exec('DELETE FROM sesiones'); // cierra todas las sesiones abiertas
  });
}

/** Verifica credenciales en tiempo aproximadamente constante. */
export async function autenticar(db: DatabaseSync, nombre: string, contrasena: string): Promise<boolean> {
  const f = db.prepare('SELECT nombre, hash_contrasena FROM usuario WHERE id = 1').get() as
    | { nombre: string; hash_contrasena: string }
    | undefined;
  const hash = f?.hash_contrasena ?? (await hashParaTiempoConstante());
  const okClave = await verificarContrasena(contrasena, hash);
  return Boolean(f) && okClave && f!.nombre.toLowerCase() === nombre.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface OpcionesSesion {
  duracionMs: number;
  inactividadMs: number;
}

export function crearSesion(db: DatabaseSync, agenteUsuario: string | undefined, op: OpcionesSesion): string {
  const token = randomBytes(32).toString('base64url');
  const ahora = new Date();
  db.prepare(
    'INSERT INTO sesiones (token_hash, creada_en, expira_en, ultimo_uso_en, agente_usuario) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), ahora.toISOString(), new Date(ahora.getTime() + op.duracionMs).toISOString(), ahora.toISOString(), agenteUsuario?.slice(0, 300) ?? null);
  return token;
}

/** Valida un token; renueva `ultimo_uso_en`. Devuelve false si no existe, expiró o quedó inactivo. */
export function validarSesion(db: DatabaseSync, token: string, op: OpcionesSesion, ahora = new Date()): boolean {
  const h = hashToken(token);
  const f = db.prepare('SELECT expira_en, ultimo_uso_en FROM sesiones WHERE token_hash = ?').get(h) as
    | { expira_en: string; ultimo_uso_en: string }
    | undefined;
  if (!f) return false;
  const vencida = new Date(f.expira_en).getTime() <= ahora.getTime();
  const inactiva = new Date(f.ultimo_uso_en).getTime() + op.inactividadMs <= ahora.getTime();
  if (vencida || inactiva) {
    db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(h);
    return false;
  }
  db.prepare('UPDATE sesiones SET ultimo_uso_en = ? WHERE token_hash = ?').run(ahora.toISOString(), h);
  return true;
}

export function cerrarSesion(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(hashToken(token));
}

export function limpiarSesionesVencidas(db: DatabaseSync, op: OpcionesSesion, ahora = new Date()): number {
  const r = db
    .prepare('DELETE FROM sesiones WHERE expira_en <= ? OR ultimo_uso_en <= ?')
    .run(ahora.toISOString(), new Date(ahora.getTime() - op.inactividadMs).toISOString());
  return Number(r.changes);
}
