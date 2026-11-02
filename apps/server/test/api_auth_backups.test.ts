import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ahoraISO } from '@mis-cuentas/core';
import { construirApp, COOKIE_SESION } from '../src/api/app';
import { crearUsuario } from '../src/auth/usuario';
import { inicializarBaseDatos } from '../src/db/inicializacion';
import { crearBackup, verificarBackup } from '../src/sistema/backups';
import { restaurarBackup } from '../src/sistema/restauracion';

describe('API HTTP, autenticación, backups y restauración', () => {
  it('protege las rutas privadas, autentica con sesión httpOnly, protege CSRF y expone estado e integridad', async () => {
    const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-cuentas-api-'));
    const rutaBd = path.join(dirTemp, 'finanzas.db');
    const dirBackups = path.join(dirTemp, 'backups');
    const { db } = await inicializarBaseDatos({ ruta: rutaBd, entorno: 'test', directorioBackups: dirBackups });
    await crearUsuario(db, 'admin', 'ClaveSegura_2026!');

    const app = await construirApp({
      db,
      entorno: 'test',
      directorioBackups: dirBackups,
      cookieSegura: false,
      sesionDuracionMs: 3600_000,
      sesionInactividadMs: 1800_000,
    });

    try {
      // /api/salud es pública
      const salud = await app.inject({ method: 'GET', url: '/api/salud' });
      expect(salud.statusCode).toBe(200);
      expect(salud.json()).toMatchObject({
        estado: 'ok',
        moneda_principal: 'PEN',
        zona_horaria: 'America/Lima',
      });

      // Sin sesión -> 401
      const sinAuth = await app.inject({ method: 'GET', url: '/api/sistema/estado' });
      expect(sinAuth.statusCode).toBe(401);

      // Login con Origin cruzado -> 403 CSRF
      const csrf = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { host: 'localhost:4300', origin: 'https://sitio-externo.mal', 'content-type': 'application/json' },
        payload: { usuario: 'admin', contrasena: 'ClaveSegura_2026!' },
      });
      expect(csrf.statusCode).toBe(403);

      // Login correcto
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { usuario: 'admin', contrasena: 'ClaveSegura_2026!' },
      });
      expect(login.statusCode).toBe(200);
      const cookieSesion = login.cookies.find((c) => c.name === COOKIE_SESION);
      expect(cookieSesion).toBeDefined();
      expect(cookieSesion?.httpOnly).toBe(true);

      const cabecerasCookie = { cookie: `${COOKIE_SESION}=${cookieSesion!.value}` };

      // Estado inicial vacío
      const estado = await app.inject({ method: 'GET', url: '/api/sistema/estado', headers: cabecerasCookie });
      expect(estado.statusCode).toBe(200);
      expect(estado.json()).toMatchObject({ vacia: true, usuario_configurado: true });

      // Integridad OK
      const integ = await app.inject({ method: 'GET', url: '/api/sistema/integridad', headers: cabecerasCookie });
      expect(integ.statusCode).toBe(200);
      expect(integ.json().ok).toBe(true);

      // Crear backup vía API
      const crearBk = await app.inject({
        method: 'POST',
        url: '/api/sistema/backups',
        headers: { ...cabecerasCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(crearBk.statusCode).toBe(201);
      expect(crearBk.json().motivo).toBe('manual');
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });

  it('crea backups verificados con SHA-256 y restaura al estado exacto previo generando un backup pre-restauración', async () => {
    const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-cuentas-bk-'));
    const rutaBd = path.join(dirTemp, 'finanzas.db');
    const dirBackups = path.join(dirTemp, 'backups');
    const rutaBloqueo = path.join(dirTemp, 'servidor.lock');

    try {
      const { db } = await inicializarBaseDatos({ ruta: rutaBd, entorno: 'test', directorioBackups: dirBackups });
      const ahora = ahoraISO();
      const cuenta1 = randomUUID();
      db.prepare(
        `INSERT INTO cuentas (id, nombre, tipo, moneda, creado_en, actualizado_en) VALUES (?, 'Cuenta 1', 'EFECTIVO', 'PEN', ?, ?)`,
      ).run(cuenta1, ahora, ahora);

      // Tomamos un backup cuando solo existe "Cuenta 1"
      const bk1 = await crearBackup(db, { directorio: dirBackups, motivo: 'manual' });
      expect(verificarBackup(bk1.ruta).valido).toBe(true);

      // Agregamos una segunda cuenta después del backup
      db.prepare(
        `INSERT INTO cuentas (id, nombre, tipo, moneda, creado_en, actualizado_en) VALUES (?, 'Cuenta 2', 'EFECTIVO', 'PEN', ?, ?)`,
      ).run(randomUUID(), ahora, ahora);
      expect((db.prepare('SELECT count(*) AS n FROM cuentas').get() as { n: number }).n).toBe(2);
      db.close();

      // Restauramos el backup 1
      const res = await restaurarBackup({
        rutaBackup: bk1.ruta,
        rutaBaseDatos: rutaBd,
        directorioBackups: dirBackups,
        rutaBloqueo,
        entorno: 'test',
      });
      expect(res.integridad.ok).toBe(true);
      expect(res.backupPrevio).not.toBeNull();
      expect(fs.existsSync(res.backupPrevio!)).toBe(true);

      // Al reabrir la BD solo está "Cuenta 1"
      const { db: dbRest } = await inicializarBaseDatos({ ruta: rutaBd, entorno: 'test', directorioBackups: dirBackups });
      const cuentas = dbRest.prepare('SELECT nombre FROM cuentas').all() as { nombre: string }[];
      expect(cuentas).toEqual([{ nombre: 'Cuenta 1' }]);
      dbRest.close();
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});
