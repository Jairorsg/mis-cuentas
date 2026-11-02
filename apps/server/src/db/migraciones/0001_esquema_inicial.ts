/**
 * Migración 0001 — Esquema inicial (núcleo contable).
 *
 * ¡NO MODIFICAR una vez aplicada en producción! El migrador guarda un checksum
 * de cada migración y se niega a arrancar si una migración ya aplicada cambió.
 * Cualquier cambio de esquema futuro va en una migración nueva.
 *
 * Garantías impuestas POR LA BASE DE DATOS (no solo por el código):
 *  - Montos enteros en unidad menor (tablas STRICT rechazan REAL).
 *  - Origen de cada transacción ∈ {MANUAL, IMPORTADO, SINCRONIZADO}.
 *    PROYECTADO y DERIVADO no pueden existir como movimientos.
 *  - Fechas contables válidas del calendario (YYYY-MM-DD).
 *  - Prohibido el borrado físico (solo eliminación lógica; la purga requiere
 *    un permiso explícito por registro y queda auditada).
 *  - Auditoría append-only (no se puede modificar ni borrar).
 *  - Imputaciones (reparto por categoría) nunca exceden el monto de su
 *    transacción y tienen su mismo signo.
 *  - Una transferencia tiene como máximo 2 patas, en cuentas distintas.
 *  - La moneda de una transacción es la de su cuenta.
 *
 * Los triggers de auditoría y de protección contra borrado se (re)generan a
 * partir de las columnas reales en cada arranque (ver db/auditoria.ts).
 */
export const migracion0001 = {
  version: 1,
  nombre: 'esquema_inicial',
  sql: /* sql */ `
-- ───────────────────────── Metadatos y control ─────────────────────────
CREATE TABLE metadatos (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
) STRICT;

CREATE TABLE _contexto_auditoria (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  valor TEXT NOT NULL
) STRICT;
INSERT INTO _contexto_auditoria (id, valor) VALUES (1, 'sistema');

CREATE TABLE _permiso_purga (
  tabla       TEXT NOT NULL,
  registro_id TEXT NOT NULL,
  PRIMARY KEY (tabla, registro_id)
) STRICT;

-- ───────────────────────── Auditoría (append-only) ─────────────────────
CREATE TABLE auditoria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tabla       TEXT NOT NULL,
  registro_id TEXT NOT NULL,
  accion      TEXT NOT NULL CHECK (accion IN ('CREACION','MODIFICACION','ELIMINACION_LOGICA','RESTAURACION','PURGA')),
  antes       TEXT CHECK (antes IS NULL OR json_valid(antes)),
  despues     TEXT CHECK (despues IS NULL OR json_valid(despues)),
  contexto    TEXT NOT NULL,
  ocurrido_en TEXT NOT NULL
) STRICT;
CREATE INDEX auditoria_registro ON auditoria (tabla, registro_id, id);

CREATE TRIGGER auditoria_inmutable_upd BEFORE UPDATE ON auditoria
BEGIN SELECT RAISE(ABORT, 'La auditoría es inmutable'); END;
CREATE TRIGGER auditoria_inmutable_del BEFORE DELETE ON auditoria
BEGIN SELECT RAISE(ABORT, 'La auditoría es inmutable'); END;

-- ───────────────────────── Catálogo de referencia ──────────────────────
CREATE TABLE monedas (
  codigo    TEXT PRIMARY KEY CHECK (length(codigo) = 3 AND codigo = upper(codigo)),
  nombre    TEXT NOT NULL,
  simbolo   TEXT NOT NULL,
  decimales INTEGER NOT NULL CHECK (decimales BETWEEN 0 AND 3)
) STRICT;
INSERT INTO monedas (codigo, nombre, simbolo, decimales) VALUES
  ('PEN','Sol peruano','S/',2),
  ('USD','Dólar estadounidense','US$',2),
  ('EUR','Euro','€',2),
  ('CLP','Peso chileno','CLP$',0),
  ('BOB','Boliviano','Bs',2),
  ('ARS','Peso argentino','ARS$',2),
  ('BRL','Real brasileño','R$',2),
  ('COP','Peso colombiano','COL$',2),
  ('MXN','Peso mexicano','MX$',2),
  ('GBP','Libra esterlina','£',2),
  ('CAD','Dólar canadiense','CA$',2),
  ('CHF','Franco suizo','CHF',2),
  ('JPY','Yen japonés','¥',0),
  ('CNY','Yuan chino','CN¥',2);

-- ───────────────────────── Usuario y sesiones ──────────────────────────
CREATE TABLE usuario (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  nombre          TEXT NOT NULL CHECK (length(trim(nombre)) > 0),
  hash_contrasena TEXT NOT NULL,
  creado_en       TEXT NOT NULL,
  actualizado_en  TEXT NOT NULL
) STRICT;

CREATE TABLE sesiones (
  token_hash     TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  creada_en      TEXT NOT NULL,
  expira_en      TEXT NOT NULL,
  ultimo_uso_en  TEXT NOT NULL,
  agente_usuario TEXT
) STRICT;

-- ───────────────────────── Cuentas ─────────────────────────────────────
CREATE TABLE cuentas (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  nombre         TEXT NOT NULL CHECK (length(trim(nombre)) > 0),
  tipo           TEXT NOT NULL CHECK (tipo IN ('EFECTIVO','CUENTA_BANCARIA','AHORRO','TARJETA_CREDITO','BILLETERA_DIGITAL','INVERSION','PRESTAMO','OTRA')),
  moneda         TEXT NOT NULL REFERENCES monedas (codigo),
  institucion    TEXT,
  notas          TEXT,
  cerrada_en     TEXT,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  eliminado_en   TEXT
) STRICT;
CREATE UNIQUE INDEX cuentas_nombre_activa ON cuentas (lower(nombre)) WHERE eliminado_en IS NULL;

-- ───────────────────────── Categorías ──────────────────────────────────
CREATE TABLE categorias (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  nombre         TEXT NOT NULL CHECK (length(trim(nombre)) > 0),
  naturaleza     TEXT NOT NULL CHECK (naturaleza IN ('GASTO','INGRESO')),
  padre_id       TEXT REFERENCES categorias (id),
  color          TEXT,
  icono          TEXT,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  eliminado_en   TEXT,
  CHECK (padre_id IS NULL OR padre_id <> id)
) STRICT;
CREATE UNIQUE INDEX categorias_nombre_activa ON categorias (coalesce(padre_id, ''), lower(nombre)) WHERE eliminado_en IS NULL;

CREATE TRIGGER categorias_naturaleza_padre_ins BEFORE INSERT ON categorias
WHEN NEW.padre_id IS NOT NULL
 AND (SELECT naturaleza FROM categorias WHERE id = NEW.padre_id) IS NOT NEW.naturaleza
BEGIN SELECT RAISE(ABORT, 'Una subcategoría debe tener la misma naturaleza que su categoría padre'); END;

CREATE TRIGGER categorias_naturaleza_padre_upd BEFORE UPDATE OF padre_id, naturaleza ON categorias
WHEN NEW.padre_id IS NOT NULL
 AND (SELECT naturaleza FROM categorias WHERE id = NEW.padre_id) IS NOT NEW.naturaleza
BEGIN SELECT RAISE(ABORT, 'Una subcategoría debe tener la misma naturaleza que su categoría padre'); END;

-- ───────────────────────── Lotes de importación ────────────────────────
CREATE TABLE lotes_importacion (
  id               TEXT PRIMARY KEY CHECK (length(id) = 36),
  cuenta_id        TEXT NOT NULL REFERENCES cuentas (id),
  archivo_nombre   TEXT NOT NULL,
  archivo_sha256   TEXT NOT NULL CHECK (length(archivo_sha256) = 64),
  formato          TEXT NOT NULL,
  filas_leidas     INTEGER NOT NULL DEFAULT 0 CHECK (filas_leidas >= 0),
  filas_importadas INTEGER NOT NULL DEFAULT 0 CHECK (filas_importadas >= 0),
  filas_omitidas   INTEGER NOT NULL DEFAULT 0 CHECK (filas_omitidas >= 0),
  notas            TEXT,
  creado_en        TEXT NOT NULL,
  actualizado_en   TEXT NOT NULL,
  eliminado_en     TEXT
) STRICT;

-- ───────────────────────── Transferencias ──────────────────────────────
CREATE TABLE transferencias (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  descripcion    TEXT,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  eliminado_en   TEXT
) STRICT;

-- ───────────────────────── Transacciones (movimientos reales) ──────────
-- monto: entero con signo en la unidad menor de la moneda de la cuenta.
--        Positivo = aumenta el saldo de la cuenta; negativo = lo disminuye.
-- monto_original/moneda_original: si la operación se hizo en otra moneda
--        (p. ej. compra en CLP con tarjeta en PEN).
-- monto_pen: equivalente en PEN. Para cuentas en PEN es igual a monto.
--        Para otras monedas es NULL hasta que exista un tipo de cambio real
--        con su fuente (nunca se inventa).
CREATE TABLE transacciones (
  id                     TEXT PRIMARY KEY CHECK (length(id) = 36),
  cuenta_id              TEXT NOT NULL REFERENCES cuentas (id),
  tipo                   TEXT NOT NULL CHECK (tipo IN ('INGRESO','GASTO','TRANSFERENCIA','SALDO_INICIAL','AJUSTE')),
  monto                  INTEGER NOT NULL CHECK (monto <> 0),
  moneda                 TEXT NOT NULL REFERENCES monedas (codigo),
  monto_original         INTEGER,
  moneda_original        TEXT REFERENCES monedas (codigo),
  monto_pen              INTEGER,
  tipo_cambio_pen        TEXT CHECK (tipo_cambio_pen IS NULL OR (tipo_cambio_pen GLOB '[0-9]*' AND CAST(tipo_cambio_pen AS REAL) > 0)),
  fuente_tipo_cambio_pen TEXT,
  fecha_contable         TEXT NOT NULL CHECK (date(fecha_contable) IS fecha_contable),
  instante               TEXT CHECK (instante IS NULL OR instante GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
  descripcion            TEXT NOT NULL CHECK (length(trim(descripcion)) > 0),
  contraparte            TEXT,
  notas                  TEXT,
  origen                 TEXT NOT NULL CHECK (origen IN ('MANUAL','IMPORTADO','SINCRONIZADO')),
  lote_importacion_id    TEXT REFERENCES lotes_importacion (id),
  fuente_sincronizacion  TEXT,
  referencia_externa     TEXT,
  huella                 TEXT,
  transferencia_id       TEXT REFERENCES transferencias (id),
  creado_en              TEXT NOT NULL,
  actualizado_en         TEXT NOT NULL,
  eliminado_en           TEXT,
  CHECK ((origen = 'IMPORTADO') = (lote_importacion_id IS NOT NULL)),
  CHECK ((origen = 'SINCRONIZADO') = (fuente_sincronizacion IS NOT NULL)),
  CHECK ((tipo = 'TRANSFERENCIA') = (transferencia_id IS NOT NULL)),
  CHECK (tipo <> 'INGRESO' OR monto > 0),
  CHECK (tipo <> 'GASTO' OR monto < 0),
  CHECK ((monto_original IS NULL) = (moneda_original IS NULL)),
  CHECK (monto_original IS NULL OR monto_original * monto > 0),
  CHECK (moneda <> 'PEN' OR monto_pen = monto),
  CHECK (monto_pen IS NULL OR monto_pen * monto >= 0),
  CHECK (moneda = 'PEN' OR monto_pen IS NULL OR (tipo_cambio_pen IS NOT NULL AND fuente_tipo_cambio_pen IS NOT NULL))
) STRICT;
CREATE INDEX transacciones_cuenta_fecha ON transacciones (cuenta_id, fecha_contable) WHERE eliminado_en IS NULL;
CREATE INDEX transacciones_fecha ON transacciones (fecha_contable) WHERE eliminado_en IS NULL;
CREATE INDEX transacciones_transferencia ON transacciones (transferencia_id) WHERE transferencia_id IS NOT NULL;
CREATE INDEX transacciones_lote ON transacciones (lote_importacion_id) WHERE lote_importacion_id IS NOT NULL;
CREATE UNIQUE INDEX transacciones_huella ON transacciones (cuenta_id, huella) WHERE huella IS NOT NULL AND eliminado_en IS NULL;

-- Moneda de la transacción = moneda de la cuenta.
CREATE TRIGGER transacciones_moneda_cuenta_ins BEFORE INSERT ON transacciones
WHEN NEW.moneda IS NOT (SELECT moneda FROM cuentas WHERE id = NEW.cuenta_id)
BEGIN SELECT RAISE(ABORT, 'La moneda de la transacción debe coincidir con la de su cuenta'); END;
CREATE TRIGGER transacciones_moneda_cuenta_upd BEFORE UPDATE OF moneda, cuenta_id ON transacciones
WHEN NEW.moneda IS NOT (SELECT moneda FROM cuentas WHERE id = NEW.cuenta_id)
BEGIN SELECT RAISE(ABORT, 'La moneda de la transacción debe coincidir con la de su cuenta'); END;

-- No registrar movimientos en cuentas eliminadas.
CREATE TRIGGER transacciones_cuenta_activa_ins BEFORE INSERT ON transacciones
WHEN (SELECT eliminado_en FROM cuentas WHERE id = NEW.cuenta_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'No se pueden registrar movimientos en una cuenta eliminada'); END;

-- Un lote de importación pertenece a una sola cuenta.
CREATE TRIGGER transacciones_lote_cuenta_ins BEFORE INSERT ON transacciones
WHEN NEW.lote_importacion_id IS NOT NULL
 AND (SELECT cuenta_id FROM lotes_importacion WHERE id = NEW.lote_importacion_id) IS NOT NEW.cuenta_id
BEGIN SELECT RAISE(ABORT, 'La transacción importada debe pertenecer a la cuenta del lote'); END;

-- El origen es inmutable (trazabilidad): editar un movimiento importado no lo convierte en manual.
CREATE TRIGGER transacciones_origen_inmutable BEFORE UPDATE OF origen, lote_importacion_id, fuente_sincronizacion, creado_en ON transacciones
WHEN NEW.origen IS NOT OLD.origen
  OR NEW.lote_importacion_id IS NOT OLD.lote_importacion_id
  OR NEW.fuente_sincronizacion IS NOT OLD.fuente_sincronizacion
  OR NEW.creado_en IS NOT OLD.creado_en
BEGIN SELECT RAISE(ABORT, 'El origen y la fecha de creación de una transacción son inmutables'); END;

-- Transferencias: máximo 2 patas activas, en cuentas distintas.
CREATE TRIGGER transacciones_transferencia_patas BEFORE INSERT ON transacciones
WHEN NEW.transferencia_id IS NOT NULL
 AND (SELECT count(*) FROM transacciones WHERE transferencia_id = NEW.transferencia_id AND eliminado_en IS NULL) >= 2
BEGIN SELECT RAISE(ABORT, 'Una transferencia solo puede tener dos patas'); END;
CREATE TRIGGER transacciones_transferencia_cuentas BEFORE INSERT ON transacciones
WHEN NEW.transferencia_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM transacciones WHERE transferencia_id = NEW.transferencia_id AND eliminado_en IS NULL AND cuenta_id = NEW.cuenta_id)
BEGIN SELECT RAISE(ABORT, 'Las patas de una transferencia deben estar en cuentas distintas'); END;

-- Una pata de transferencia no se elimina/restaura sola: se opera sobre la transferencia completa.
CREATE TRIGGER transacciones_transferencia_eliminar_sola BEFORE UPDATE OF eliminado_en ON transacciones
WHEN NEW.transferencia_id IS NOT NULL
 AND (NEW.eliminado_en IS NULL) <> (OLD.eliminado_en IS NULL)
 AND ((SELECT eliminado_en FROM transferencias WHERE id = NEW.transferencia_id) IS NULL) <> (NEW.eliminado_en IS NULL)
BEGIN SELECT RAISE(ABORT, 'Elimine o restaure la transferencia completa, no una sola pata'); END;

-- Cascada lógica: transferencia → patas.
CREATE TRIGGER transferencias_cascada_eliminar AFTER UPDATE OF eliminado_en ON transferencias
WHEN OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL
BEGIN
  UPDATE transacciones SET eliminado_en = NEW.eliminado_en, actualizado_en = NEW.eliminado_en
   WHERE transferencia_id = NEW.id AND eliminado_en IS NULL;
END;
CREATE TRIGGER transferencias_cascada_restaurar AFTER UPDATE OF eliminado_en ON transferencias
WHEN OLD.eliminado_en IS NOT NULL AND NEW.eliminado_en IS NULL
BEGIN
  UPDATE transacciones SET eliminado_en = NULL, actualizado_en = NEW.actualizado_en
   WHERE transferencia_id = NEW.id AND eliminado_en = OLD.eliminado_en;
END;

-- Cascada lógica: lote de importación → sus transacciones (deshacer importación).
CREATE TRIGGER lotes_cascada_eliminar AFTER UPDATE OF eliminado_en ON lotes_importacion
WHEN OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL
BEGIN
  UPDATE transacciones SET eliminado_en = NEW.eliminado_en, actualizado_en = NEW.eliminado_en
   WHERE lote_importacion_id = NEW.id AND eliminado_en IS NULL;
END;
CREATE TRIGGER lotes_cascada_restaurar AFTER UPDATE OF eliminado_en ON lotes_importacion
WHEN OLD.eliminado_en IS NOT NULL AND NEW.eliminado_en IS NULL
BEGIN
  UPDATE transacciones SET eliminado_en = NULL, actualizado_en = NEW.actualizado_en
   WHERE lote_importacion_id = NEW.id AND eliminado_en = OLD.eliminado_en;
END;

-- Una cuenta con movimientos activos no se elimina (se cierra con cerrada_en).
CREATE TRIGGER cuentas_eliminar_con_movimientos BEFORE UPDATE OF eliminado_en ON cuentas
WHEN OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL
 AND EXISTS (SELECT 1 FROM transacciones WHERE cuenta_id = NEW.id AND eliminado_en IS NULL)
BEGIN SELECT RAISE(ABORT, 'La cuenta tiene movimientos activos: ciérrela en lugar de eliminarla'); END;

-- La moneda de una cuenta con movimientos no puede cambiar.
CREATE TRIGGER cuentas_moneda_inmutable BEFORE UPDATE OF moneda ON cuentas
WHEN NEW.moneda IS NOT OLD.moneda
 AND EXISTS (SELECT 1 FROM transacciones WHERE cuenta_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'No se puede cambiar la moneda de una cuenta con movimientos'); END;

-- ───────────────────────── Imputaciones (reparto por categoría) ────────
-- Cada INGRESO/GASTO se reparte en una o más imputaciones cuya suma debe ser
-- exactamente el monto de la transacción. La BD impide exceder el monto; el
-- verificador de integridad detecta repartos incompletos.
CREATE TABLE imputaciones (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),
  transaccion_id TEXT NOT NULL REFERENCES transacciones (id),
  categoria_id   TEXT REFERENCES categorias (id),
  monto          INTEGER NOT NULL CHECK (monto <> 0),
  nota           TEXT,
  creado_en      TEXT NOT NULL,
  actualizado_en TEXT NOT NULL,
  eliminado_en   TEXT
) STRICT;
CREATE INDEX imputaciones_transaccion ON imputaciones (transaccion_id) WHERE eliminado_en IS NULL;
CREATE INDEX imputaciones_categoria ON imputaciones (categoria_id) WHERE eliminado_en IS NULL;

CREATE TRIGGER imputaciones_tipo_ins BEFORE INSERT ON imputaciones
WHEN (SELECT tipo FROM transacciones WHERE id = NEW.transaccion_id) NOT IN ('INGRESO','GASTO')
BEGIN SELECT RAISE(ABORT, 'Solo los ingresos y gastos se imputan a categorías'); END;

CREATE TRIGGER imputaciones_transaccion_activa_ins BEFORE INSERT ON imputaciones
WHEN NEW.eliminado_en IS NULL
 AND (SELECT eliminado_en FROM transacciones WHERE id = NEW.transaccion_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'No se puede imputar una transacción eliminada'); END;

CREATE TRIGGER imputaciones_signo_ins BEFORE INSERT ON imputaciones
WHEN NEW.monto * (SELECT monto FROM transacciones WHERE id = NEW.transaccion_id) <= 0
BEGIN SELECT RAISE(ABORT, 'La imputación debe tener el mismo signo que su transacción'); END;
CREATE TRIGGER imputaciones_signo_upd BEFORE UPDATE OF monto, transaccion_id ON imputaciones
WHEN NEW.monto * (SELECT monto FROM transacciones WHERE id = NEW.transaccion_id) <= 0
BEGIN SELECT RAISE(ABORT, 'La imputación debe tener el mismo signo que su transacción'); END;

CREATE TRIGGER imputaciones_exceso_ins BEFORE INSERT ON imputaciones
WHEN NEW.eliminado_en IS NULL
 AND abs(coalesce((SELECT sum(monto) FROM imputaciones WHERE transaccion_id = NEW.transaccion_id AND eliminado_en IS NULL), 0) + NEW.monto)
     > abs((SELECT monto FROM transacciones WHERE id = NEW.transaccion_id))
BEGIN SELECT RAISE(ABORT, 'Las imputaciones exceden el monto de la transacción'); END;
CREATE TRIGGER imputaciones_exceso_upd BEFORE UPDATE OF monto, eliminado_en, transaccion_id ON imputaciones
WHEN NEW.eliminado_en IS NULL
 AND abs(coalesce((SELECT sum(monto) FROM imputaciones WHERE transaccion_id = NEW.transaccion_id AND eliminado_en IS NULL AND id <> NEW.id), 0) + NEW.monto)
     > abs((SELECT monto FROM transacciones WHERE id = NEW.transaccion_id))
BEGIN SELECT RAISE(ABORT, 'Las imputaciones exceden el monto de la transacción'); END;

-- Reducir el monto de una transacción por debajo de lo ya imputado está prohibido.
CREATE TRIGGER transacciones_monto_vs_imputaciones BEFORE UPDATE OF monto ON transacciones
WHEN abs(NEW.monto) < abs(coalesce((SELECT sum(monto) FROM imputaciones WHERE transaccion_id = NEW.id AND eliminado_en IS NULL), 0))
  OR EXISTS (SELECT 1 FROM imputaciones WHERE transaccion_id = NEW.id AND eliminado_en IS NULL AND monto * NEW.monto <= 0)
BEGIN SELECT RAISE(ABORT, 'El nuevo monto es incompatible con las imputaciones existentes; ajústelas primero'); END;

-- Cascada lógica: transacción → imputaciones.
CREATE TRIGGER transacciones_cascada_eliminar AFTER UPDATE OF eliminado_en ON transacciones
WHEN OLD.eliminado_en IS NULL AND NEW.eliminado_en IS NOT NULL
BEGIN
  UPDATE imputaciones SET eliminado_en = NEW.eliminado_en, actualizado_en = NEW.eliminado_en
   WHERE transaccion_id = NEW.id AND eliminado_en IS NULL;
END;
CREATE TRIGGER transacciones_cascada_restaurar AFTER UPDATE OF eliminado_en ON transacciones
WHEN OLD.eliminado_en IS NOT NULL AND NEW.eliminado_en IS NULL
BEGIN
  UPDATE imputaciones SET eliminado_en = NULL, actualizado_en = NEW.actualizado_en
   WHERE transaccion_id = NEW.id AND eliminado_en = OLD.eliminado_en;
END;

-- ───────────────────────── Vistas (datos DERIVADOS) ────────────────────
-- Saldo de cada cuenta = suma de sus movimientos reales activos.
CREATE VIEW v_saldos_cuentas AS
SELECT c.id AS cuenta_id,
       c.nombre,
       c.moneda,
       coalesce(sum(t.monto), 0) AS saldo,
       count(t.id) AS movimientos,
       'DERIVADO' AS origen
  FROM cuentas c
  LEFT JOIN transacciones t ON t.cuenta_id = c.id AND t.eliminado_en IS NULL
 WHERE c.eliminado_en IS NULL
 GROUP BY c.id;
`,
} as const;
