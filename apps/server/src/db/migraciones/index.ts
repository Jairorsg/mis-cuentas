import { migracion0001 } from './0001_esquema_inicial';

export interface Migracion {
  readonly version: number;
  readonly nombre: string;
  readonly sql: string;
}

/**
 * Lista ordenada de migraciones. Para cambiar el esquema, AGREGUE una nueva
 * migración al final; nunca edite una ya publicada.
 */
export const MIGRACIONES: readonly Migracion[] = [migracion0001];

/**
 * Tablas auditadas y protegidas contra borrado físico. Al agregar tablas
 * financieras en fases futuras, regístrelas aquí: los triggers se regeneran
 * automáticamente según sus columnas reales.
 */
export const TABLAS_AUDITADAS: readonly { tabla: string; clave: string }[] = [
  { tabla: 'monedas', clave: 'codigo' },
  { tabla: 'cuentas', clave: 'id' },
  { tabla: 'categorias', clave: 'id' },
  { tabla: 'lotes_importacion', clave: 'id' },
  { tabla: 'transferencias', clave: 'id' },
  { tabla: 'transacciones', clave: 'id' },
  { tabla: 'imputaciones', clave: 'id' },
];

/** Tablas cuyos registros representan datos financieros del usuario. */
export const TABLAS_FINANCIERAS: readonly string[] = [
  'cuentas',
  'categorias',
  'lotes_importacion',
  'transferencias',
  'transacciones',
  'imputaciones',
];
