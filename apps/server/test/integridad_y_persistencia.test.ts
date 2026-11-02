import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ahoraISO, CATALOGO_MONEDAS } from '@mis-cuentas/core';
import { conAuditoria, purgarRegistro } from '../src/db/auditoria';
import { ErrorGuardiaEntorno, validarRutaParaEntorno } from '../src/db/conexion';
import { inicializarBaseDatos } from '../src/db/inicializacion';
import { estadoDatos } from '../src/sistema/estado';
import { verificarIntegridad } from '../src/sistema/integridad';

describe('Guardias de entorno, BD vacía inicial, auditoría e integridad contable', () => {
  it('impide abrir rutas fuera de tmpdir en entorno test o abrir entornos de producción desde Vitest', () => {
    expect(() => validarRutaParaEntorno(':memory:', 'test')).not.toThrow();
    expect(() => validarRutaParaEntorno('f:\\PROYECTOS\\MIS CUENTAS\\data\\finanzas.db', 'test')).toThrow(
      ErrorGuardiaEntorno,
    );
    expect(() => validarRutaParaEntorno('f:\\PROYECTOS\\MIS CUENTAS\\data\\finanzas.db', 'production')).toThrow(
      ErrorGuardiaEntorno,
    );
  });

  it('inicializa una base de datos completamente vacía de registros financieros y sincronizada con el catálogo de monedas', async () => {
    const { db, version } = await inicializarBaseDatos({ ruta: ':memory:', entorno: 'test' });
    try {
      expect(version).toBe(1);
      const estado = estadoDatos(db);
      expect(estado.vacia).toBe(true);
      expect(estado.usuario_configurado).toBe(false);
      expect(estado.transacciones_por_origen).toEqual({ MANUAL: 0, IMPORTADO: 0, SINCRONIZADO: 0 });

      const monedasBd = db.prepare('SELECT codigo, nombre, simbolo, decimales FROM monedas ORDER BY codigo').all();
      const esperado = [...CATALOGO_MONEDAS].sort((a, b) => a.codigo.localeCompare(b.codigo));
      expect(monedasBd).toEqual(esperado);

      const rep = verificarIntegridad(db);
      expect(rep.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rechaza orígenes no reales (PROYECTADO/DERIVADO), fechas inválidas, flotantes y signos incoherentes en transacciones', async () => {
    const { db } = await inicializarBaseDatos({ ruta: ':memory:', entorno: 'test' });
    try {
      const cuentaId = randomUUID();
      const ahora = ahoraISO();
      db.prepare(
        `INSERT INTO cuentas (id, nombre, tipo, moneda, creado_en, actualizado_en) VALUES (?, 'Billetera', 'EFECTIVO', 'PEN', ?, ?)`,
      ).run(cuentaId, ahora, ahora);

      const insTx = db.prepare(`
        INSERT INTO transacciones (
          id, cuenta_id, tipo, monto, moneda, monto_pen, fecha_contable, descripcion, origen, creado_en, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Prueba', ?, ?, ?)
      `);

      // PROYECTADO o DERIVADO no pueden insertarse como movimiento real
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', -1000, 'PEN', -1000, '2026-11-01', 'PROYECTADO', ahora, ahora),
      ).toThrow();
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', -1000, 'PEN', -1000, '2026-11-01', 'DERIVADO', ahora, ahora),
      ).toThrow();

      // Fecha contable inexistente (30 de febrero)
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', -1000, 'PEN', -1000, '2026-02-30', 'MANUAL', ahora, ahora),
      ).toThrow();

      // Número en punto flotante (rechazado por STRICT INTEGER)
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', -10.5, 'PEN', -10.5, '2026-11-01', 'MANUAL', ahora, ahora),
      ).toThrow();

      // GASTO con signo positivo o INGRESO con signo negativo
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', 1000, 'PEN', 1000, '2026-11-01', 'MANUAL', ahora, ahora),
      ).toThrow();
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'INGRESO', -1000, 'PEN', -1000, '2026-11-01', 'MANUAL', ahora, ahora),
      ).toThrow();

      // Moneda distinta a la de la cuenta
      expect(() =>
        insTx.run(randomUUID(), cuentaId, 'GASTO', -1000, 'USD', null, '2026-11-01', 'MANUAL', ahora, ahora),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('audita automáticamente creaciones, ediciones, eliminaciones lógicas, restauraciones y prohíbe el borrado físico directo', async () => {
    const { db } = await inicializarBaseDatos({ ruta: ':memory:', entorno: 'test' });
    try {
      const cuentaId = randomUUID();
      const catId = randomUUID();
      const txId = randomUUID();
      const impId = randomUUID();
      const ahora = ahoraISO();

      conAuditoria(db, 'prueba:alta', () => {
        db.prepare(
          `INSERT INTO cuentas (id, nombre, tipo, moneda, creado_en, actualizado_en) VALUES (?, 'Cuenta Soles', 'CUENTA_BANCARIA', 'PEN', ?, ?)`,
        ).run(cuentaId, ahora, ahora);
        db.prepare(
          `INSERT INTO categorias (id, nombre, naturaleza, creado_en, actualizado_en) VALUES (?, 'Alimentación', 'GASTO', ?, ?)`,
        ).run(catId, ahora, ahora);
        db.prepare(
          `INSERT INTO transacciones (id, cuenta_id, tipo, monto, moneda, monto_pen, fecha_contable, descripcion, origen, creado_en, actualizado_en)
           VALUES (?, ?, 'GASTO', -2550, 'PEN', -2550, '2026-11-01', 'Almuerzo', 'MANUAL', ?, ?)`,
        ).run(txId, cuentaId, ahora, ahora);
        db.prepare(
          `INSERT INTO imputaciones (id, transaccion_id, categoria_id, monto, creado_en, actualizado_en)
           VALUES (?, ?, ?, -2550, ?, ?)`,
        ).run(impId, txId, catId, ahora, ahora);
      });

      // El saldo derivado en v_saldos_cuentas refleja exactamente -2550 y etiqueta DERIVADO
      const saldo = db.prepare('SELECT saldo, movimientos, origen FROM v_saldos_cuentas WHERE cuenta_id = ?').get(cuentaId) as {
        saldo: number;
        movimientos: number;
        origen: string;
      };
      expect(saldo).toEqual({ saldo: -2550, movimientos: 1, origen: 'DERIVADO' });

      // El origen de una transacción es inmutable
      expect(() =>
        db.prepare(`UPDATE transacciones SET origen = 'IMPORTADO' WHERE id = ?`).run(txId),
      ).toThrow();

      // Las imputaciones no pueden exceder el monto de la transacción
      expect(() =>
        db
          .prepare(
            `INSERT INTO imputaciones (id, transaccion_id, categoria_id, monto, creado_en, actualizado_en) VALUES (?, ?, ?, -100, ?, ?)`,
          )
          .run(randomUUID(), txId, catId, ahora, ahora),
      ).toThrow();

      // Prohibido borrar físicamente sin permiso de purga
      expect(() => db.prepare('DELETE FROM transacciones WHERE id = ?').run(txId)).toThrow(
        /Eliminación física prohibida/,
      );

      // Eliminación lógica en cascada a imputaciones
      const tElim = ahoraISO();
      conAuditoria(db, 'prueba:eliminar', () => {
        db.prepare('UPDATE transacciones SET eliminado_en = ?, actualizado_en = ? WHERE id = ?').run(tElim, tElim, txId);
      });
      const saldoTrasEliminar = db
        .prepare('SELECT saldo, movimientos FROM v_saldos_cuentas WHERE cuenta_id = ?')
        .get(cuentaId) as { saldo: number; movimientos: number };
      expect(saldoTrasEliminar).toEqual({ saldo: 0, movimientos: 0 });

      // Restauración en cascada a imputaciones
      const tRest = ahoraISO();
      conAuditoria(db, 'prueba:restaurar', () => {
        db.prepare('UPDATE transacciones SET eliminado_en = NULL, actualizado_en = ? WHERE id = ?').run(tRest, txId);
      });
      expect(verificarIntegridad(db).ok).toBe(true);

      // Historial de auditoría completo e inmutable
      const eventos = db
        .prepare(`SELECT accion, contexto FROM auditoria WHERE tabla = 'transacciones' AND registro_id = ? ORDER BY id`)
        .all(txId) as { accion: string; contexto: string }[];
      expect(eventos).toEqual([
        { accion: 'CREACION', contexto: 'prueba:alta' },
        { accion: 'ELIMINACION_LOGICA', contexto: 'prueba:eliminar' },
        { accion: 'RESTAURACION', contexto: 'prueba:restaurar' },
      ]);

      expect(() => db.exec(`DELETE FROM auditoria`)).toThrow(/inmutable/);
      expect(() => db.exec(`UPDATE auditoria SET contexto = 'x'`)).toThrow(/inmutable/);

      // Purga explícita autorizada deja registro 'PURGA' en auditoría
      purgarRegistro(db, 'imputaciones', impId, 'prueba:purga');
      purgarRegistro(db, 'transacciones', txId, 'prueba:purga');
      const ultimoEvento = db
        .prepare(`SELECT accion, antes, despues FROM auditoria WHERE tabla = 'transacciones' AND registro_id = ? ORDER BY id DESC LIMIT 1`)
        .get(txId) as { accion: string; antes: string | null; despues: string | null };
      expect(ultimoEvento.accion).toBe('PURGA');
      expect(ultimoEvento.antes).not.toBeNull();
      expect(ultimoEvento.despues).toBeNull();
    } finally {
      db.close();
    }
  });

  it('persiste en disco en un archivo temporal y conserva la integridad al cerrar y reabrir', async () => {
    const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-cuentas-test-'));
    const rutaBd = path.join(dirTemp, 'finanzas.db');
    const dirBackups = path.join(dirTemp, 'backups');
    try {
      const cuentaId = randomUUID();
      {
        const { db } = await inicializarBaseDatos({ ruta: rutaBd, entorno: 'test', directorioBackups: dirBackups });
        const ahora = ahoraISO();
        db.prepare(
          `INSERT INTO cuentas (id, nombre, tipo, moneda, creado_en, actualizado_en) VALUES (?, 'Ahorros BCP', 'AHORRO', 'PEN', ?, ?)`,
        ).run(cuentaId, ahora, ahora);
        db.close();
      }
      {
        const { db, migracionesAplicadas } = await inicializarBaseDatos({
          ruta: rutaBd,
          entorno: 'test',
          directorioBackups: dirBackups,
        });
        expect(migracionesAplicadas).toEqual([]);
        const c = db.prepare('SELECT nombre FROM cuentas WHERE id = ?').get(cuentaId) as { nombre: string };
        expect(c.nombre).toBe('Ahorros BCP');
        expect(verificarIntegridad(db).ok).toBe(true);
        db.close();
      }
    } finally {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    }
  });
});
