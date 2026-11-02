/**
 * Aplicación HTTP (Fastify).
 *
 * Seguridad:
 *  - Todas las rutas /api requieren sesión, excepto /api/salud y /api/auth/login.
 *  - Cookie de sesión httpOnly + SameSite=Strict (+ Secure con HTTPS).
 *  - Peticiones que modifican estado: deben ser JSON y, si traen cabecera
 *    Origin, debe coincidir con el host (defensa CSRF).
 *  - Límite de intentos de inicio de sesión por IP.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { fechaHoraLima, MONEDA_PRINCIPAL, ZONA_HORARIA } from '@mis-cuentas/core';
import { z } from 'zod';
import { autenticar, cerrarSesion, crearSesion, obtenerUsuario, validarSesion } from '../auth/usuario';
import type { Entorno } from '../config';
import { versionEsquema } from '../db/migrador';
import { crearBackup, listarBackups } from '../sistema/backups';
import { estadoDatos } from '../sistema/estado';
import { construirExportacion } from '../sistema/exportacion';
import { verificarIntegridad } from '../sistema/integridad';
import { LimitadorIntentos } from './limitador';

export const COOKIE_SESION = 'mc_sesion';

export interface OpcionesApp {
  db: DatabaseSync;
  entorno: Entorno;
  directorioBackups: string;
  cookieSegura: boolean;
  sesionDuracionMs: number;
  sesionInactividadMs: number;
  logger?: boolean;
}

const RUTAS_PUBLICAS = new Set(['/api/salud', '/api/auth/login']);
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

class ErrorHttp extends Error {
  readonly status: number;
  readonly codigo: string;
  constructor(status: number, codigo: string, mensaje: string) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

export async function construirApp(op: OpcionesApp): Promise<FastifyInstance> {
  const app = Fastify({
    logger: op.logger
      ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'] }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  const { db } = op;
  const opSesion = { duracionMs: op.sesionDuracionMs, inactividadMs: op.sesionInactividadMs };
  const limitador = new LimitadorIntentos({ maxIntentos: 5, ventanaMs: 15 * 60 * 1000 });

  await app.register(cookie);

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  // Defensa CSRF para métodos que modifican estado.
  app.addHook('onRequest', async (req) => {
    if (METODOS_SEGUROS.has(req.method)) return;
    const origen = req.headers.origin;
    if (origen) {
      let hostOrigen: string;
      try {
        hostOrigen = new URL(origen).host;
      } catch {
        throw new ErrorHttp(403, 'ORIGEN_INVALIDO', 'Origen inválido');
      }
      if (hostOrigen !== req.headers.host) throw new ErrorHttp(403, 'ORIGEN_NO_PERMITIDO', 'Origen no permitido');
    }
    const tipo = req.headers['content-type'] ?? '';
    if (!tipo.startsWith('application/json')) {
      throw new ErrorHttp(415, 'TIPO_CONTENIDO', 'Las peticiones que modifican datos deben ser application/json');
    }
  });

  // Autenticación.
  app.addHook('preHandler', async (req) => {
    const ruta = req.routeOptions.url ?? req.url;
    if (!ruta.startsWith('/api/') || RUTAS_PUBLICAS.has(ruta)) return;
    const token = req.cookies[COOKIE_SESION];
    if (!token || !validarSesion(db, token, opSesion)) {
      throw new ErrorHttp(401, 'NO_AUTENTICADO', 'Inicie sesión');
    }
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ErrorHttp) {
      return reply.status(err.status).send({ error: { codigo: err.codigo, mensaje: err.message } });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: { codigo: 'VALIDACION', mensaje: 'Datos inválidos', detalles: err.issues } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { codigo: 'PETICION_INVALIDA', mensaje: e.message ?? 'Error' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { codigo: 'ERROR_INTERNO', mensaje: 'Error interno del servidor' } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { codigo: 'NO_ENCONTRADO', mensaje: 'Recurso no encontrado' } });
  });

  // ─────────── Salud (pública) ───────────
  app.get('/api/salud', async () => ({
    estado: 'ok',
    entorno: op.entorno,
    version_esquema: versionEsquema(db),
    zona_horaria: ZONA_HORARIA,
    moneda_principal: MONEDA_PRINCIPAL,
    hora_lima: fechaHoraLima(new Date()),
  }));

  // ─────────── Autenticación ───────────
  const esquemaLogin = z.object({
    usuario: z.string().min(1).max(100),
    contrasena: z.string().min(1).max(500),
  });

  app.post('/api/auth/login', async (req, reply) => {
    const clave = req.ip;
    if (limitador.bloqueado(clave)) {
      throw new ErrorHttp(429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos. Espere unos minutos.');
    }
    const body = esquemaLogin.parse(req.body);
    const ok = await autenticar(db, body.usuario, body.contrasena);
    if (!ok) {
      limitador.registrarFallo(clave);
      throw new ErrorHttp(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos');
    }
    limitador.reiniciar(clave);
    const token = crearSesion(db, req.headers['user-agent'], opSesion);
    reply.setCookie(COOKIE_SESION, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: op.cookieSegura,
      path: '/',
      maxAge: Math.floor(op.sesionDuracionMs / 1000),
    });
    return { autenticado: true, usuario: obtenerUsuario(db)?.nombre };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE_SESION];
    if (token) cerrarSesion(db, token);
    reply.clearCookie(COOKIE_SESION, { path: '/' });
    return { autenticado: false };
  });

  app.get('/api/auth/sesion', async () => ({ autenticado: true, usuario: obtenerUsuario(db)?.nombre }));

  // ─────────── Sistema ───────────
  app.get('/api/sistema/estado', async () => estadoDatos(db));

  app.get('/api/sistema/integridad', async () => verificarIntegridad(db));

  app.get('/api/sistema/backups', async () => ({
    backups: listarBackups(op.directorioBackups).map(({ ruta: _ruta, ...resto }) => resto),
  }));

  app.post('/api/sistema/backups', async (_req, reply) => {
    const { ruta: _ruta, ...info } = await crearBackup(db, { directorio: op.directorioBackups, motivo: 'manual' });
    reply.status(201);
    return info;
  });

  const esquemaAuditoria = z.object({
    tabla: z.string().regex(/^[a-z_]+$/).optional(),
    registro_id: z.string().max(100).optional(),
    limite: z.coerce.number().int().min(1).max(500).default(100),
    antes_de: z.coerce.number().int().positive().optional(),
  });
  app.get('/api/sistema/auditoria', async (req) => {
    const q = esquemaAuditoria.parse(req.query);
    const condiciones: string[] = [];
    const params: (string | number)[] = [];
    if (q.tabla) {
      condiciones.push('tabla = ?');
      params.push(q.tabla);
    }
    if (q.registro_id) {
      condiciones.push('registro_id = ?');
      params.push(q.registro_id);
    }
    if (q.antes_de) {
      condiciones.push('id < ?');
      params.push(q.antes_de);
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const filas = db
      .prepare(`SELECT * FROM auditoria ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, q.limite) as Record<string, unknown>[];
    return {
      eventos: filas.map((f) => ({
        ...f,
        antes: f.antes ? JSON.parse(String(f.antes)) : null,
        despues: f.despues ? JSON.parse(String(f.despues)) : null,
      })),
    };
  });

  app.get('/api/sistema/exportacion', async (_req, reply) => {
    const exp = construirExportacion(db);
    reply.header('Content-Disposition', `attachment; filename="mis-cuentas-exportacion.json"`);
    return exp;
  });

  return app;
}
