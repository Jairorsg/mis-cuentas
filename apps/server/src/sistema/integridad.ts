/**
 * Verificador de integridad financiera.
 *
 * Complementa las restricciones de la BD detectando estados que no se pueden
 * impedir fila por fila (p. ej. un reparto por categorías incompleto, o una
 * transferencia con una sola pata). Se ejecuta al arrancar, bajo demanda
 * (API/CLI) y tras cada restauración.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ahoraISO } from '@mis-cuentas/core';
import { TABLAS_AUDITADAS } from '../db/migraciones/index';

export interface Comprobacion {
  codigo: string;
  descripcion: string;
  estado: 'OK' | 'ERROR';
  total: number;
  /** Hasta 50 identificadores o detalles afectados. */
  muestras: unknown[];
}

export interface ReporteIntegridad {
  ok: boolean;
  verificado_en: string;
  comprobaciones: Comprobacion[];
}

const LIMITE_MUESTRAS = 50;

function porConsulta(db: DatabaseSync, codigo: string, descripcion: string, sql: string): Comprobacion {
  const filas = db.prepare(sql).all() as Record<string, unknown>[];
  return {
    codigo,
    descripcion,
    estado: filas.length === 0 ? 'OK' : 'ERROR',
    total: filas.length,
    muestras: filas.slice(0, LIMITE_MUESTRAS).map((f) => ({ ...f })),
  };
}

export function verificarIntegridad(db: DatabaseSync): ReporteIntegridad {
  const comprobaciones: Comprobacion[] = [];

  const ic = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  const icErrores = ic.filter((f) => f.integrity_check !== 'ok');
  comprobaciones.push({
    codigo: 'SQLITE_INTEGRIDAD',
    descripcion: 'Integridad física del archivo SQLite',
    estado: icErrores.length === 0 ? 'OK' : 'ERROR',
    total: icErrores.length,
    muestras: icErrores.slice(0, LIMITE_MUESTRAS),
  });

  const fk = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
  comprobaciones.push({
    codigo: 'CLAVES_FORANEAS',
    descripcion: 'Referencias entre tablas válidas',
    estado: fk.length === 0 ? 'OK' : 'ERROR',
    total: fk.length,
    muestras: fk.slice(0, LIMITE_MUESTRAS).map((f) => ({ ...f })),
  });

  comprobaciones.push(
    porConsulta(
      db,
      'MONEDA_CUENTA',
      'Cada transacción está en la moneda de su cuenta',
      `SELECT t.id FROM transacciones t JOIN cuentas c ON c.id = t.cuenta_id WHERE t.moneda <> c.moneda`,
    ),
    porConsulta(
      db,
      'IMPUTACION_FALTANTE',
      'Todo ingreso o gasto activo está imputado a categorías',
      `SELECT t.id FROM transacciones t
        WHERE t.eliminado_en IS NULL AND t.tipo IN ('INGRESO','GASTO')
          AND NOT EXISTS (SELECT 1 FROM imputaciones i WHERE i.transaccion_id = t.id AND i.eliminado_en IS NULL)`,
    ),
    porConsulta(
      db,
      'IMPUTACION_SUMA',
      'La suma de imputaciones es exactamente el monto de la transacción (sin doble conteo ni faltantes)',
      `SELECT t.id, t.monto, sum(i.monto) AS imputado FROM transacciones t
         JOIN imputaciones i ON i.transaccion_id = t.id AND i.eliminado_en IS NULL
        WHERE t.eliminado_en IS NULL
        GROUP BY t.id HAVING sum(i.monto) <> t.monto`,
    ),
    porConsulta(
      db,
      'IMPUTACION_HUERFANA',
      'No hay imputaciones activas de transacciones eliminadas o de tipo no imputable',
      `SELECT i.id FROM imputaciones i JOIN transacciones t ON t.id = i.transaccion_id
        WHERE i.eliminado_en IS NULL AND (t.eliminado_en IS NOT NULL OR t.tipo NOT IN ('INGRESO','GASTO'))`,
    ),
    porConsulta(
      db,
      'TRANSFERENCIA_PATAS',
      'Cada transferencia activa tiene exactamente dos patas activas en cuentas distintas',
      `SELECT tr.id, count(t.id) AS patas, count(DISTINCT t.cuenta_id) AS cuentas FROM transferencias tr
         LEFT JOIN transacciones t ON t.transferencia_id = tr.id AND t.eliminado_en IS NULL
        WHERE tr.eliminado_en IS NULL
        GROUP BY tr.id HAVING count(t.id) <> 2 OR count(DISTINCT t.cuenta_id) <> 2`,
    ),
    porConsulta(
      db,
      'TRANSFERENCIA_BALANCE',
      'Las transferencias en la misma moneda suman cero (salida = entrada)',
      `SELECT tr.id, sum(t.monto) AS diferencia FROM transferencias tr
         JOIN transacciones t ON t.transferencia_id = tr.id AND t.eliminado_en IS NULL
        WHERE tr.eliminado_en IS NULL
        GROUP BY tr.id HAVING count(DISTINCT t.moneda) = 1 AND sum(t.monto) <> 0`,
    ),
    porConsulta(
      db,
      'TRANSFERENCIA_SIGNOS',
      'Cada transferencia tiene una pata de salida y una de entrada',
      `SELECT tr.id FROM transferencias tr
         JOIN transacciones t ON t.transferencia_id = tr.id AND t.eliminado_en IS NULL
        WHERE tr.eliminado_en IS NULL
        GROUP BY tr.id HAVING sum(t.monto > 0) <> 1 OR sum(t.monto < 0) <> 1`,
    ),
    porConsulta(
      db,
      'TRANSFERENCIA_ELIMINADA_ACTIVA',
      'Ninguna pata activa pertenece a una transferencia eliminada',
      `SELECT t.id FROM transacciones t JOIN transferencias tr ON tr.id = t.transferencia_id
        WHERE t.eliminado_en IS NULL AND tr.eliminado_en IS NOT NULL`,
    ),
    porConsulta(
      db,
      'CUENTA_ELIMINADA_ACTIVA',
      'Ninguna transacción activa pertenece a una cuenta eliminada',
      `SELECT t.id FROM transacciones t JOIN cuentas c ON c.id = t.cuenta_id
        WHERE t.eliminado_en IS NULL AND c.eliminado_en IS NOT NULL`,
    ),
    porConsulta(
      db,
      'LOTE_ELIMINADO_ACTIVO',
      'Ninguna transacción activa pertenece a una importación revertida',
      `SELECT t.id FROM transacciones t JOIN lotes_importacion l ON l.id = t.lote_importacion_id
        WHERE t.eliminado_en IS NULL AND l.eliminado_en IS NOT NULL`,
    ),
  );

  // Todo registro auditado debe tener su evento de creación en la auditoría:
  // detecta escrituras que hayan esquivado los triggers.
  const sinAuditoria: unknown[] = [];
  for (const { tabla, clave } of TABLAS_AUDITADAS) {
    const filas = db
      .prepare(
        `SELECT '${tabla}' AS tabla, x.${clave} AS id FROM ${tabla} x
          WHERE NOT EXISTS (SELECT 1 FROM auditoria a WHERE a.tabla = '${tabla}' AND a.registro_id = x.${clave} AND a.accion = 'CREACION')`,
      )
      .all();
    // El catálogo de monedas se inserta en la migración antes de que existan los triggers.
    if (tabla !== 'monedas') sinAuditoria.push(...filas);
  }
  comprobaciones.push({
    codigo: 'AUDITORIA_COMPLETA',
    descripcion: 'Todo registro financiero tiene historial de creación',
    estado: sinAuditoria.length === 0 ? 'OK' : 'ERROR',
    total: sinAuditoria.length,
    muestras: sinAuditoria.slice(0, LIMITE_MUESTRAS).map((f) => ({ ...(f as object) })),
  });

  return {
    ok: comprobaciones.every((c) => c.estado === 'OK'),
    verificado_en: ahoraISO(),
    comprobaciones,
  };
}
