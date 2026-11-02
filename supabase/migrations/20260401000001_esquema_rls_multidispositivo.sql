-- =============================================================================
-- MIGRACIÓN SUPABASE / POSTGRESQL: ESQUEMA MULTIDISPOSITIVO Y ROW LEVEL SECURITY
-- Proyecto: Sistema de Gestión Financiera Personal Permanente (Mis Cuentas)
-- =============================================================================
-- REGLAS GARANTIZADAS:
-- 1. Uso estrictamente privado y personal: ningún rol anónimo (`anon`) tiene
--    permiso de lectura ni escritura.
-- 2. Row Level Security (RLS) habilitado y forzado en TODAS las tablas.
-- 3. Cada registro pertenece exclusivamente a `propietario_id = auth.uid()`.
-- 4. Control optimista de versiones (`version`) y detección de conflictos para
--    impedir sobrescrituras silenciosas entre PC y celular.
-- =============================================================================

create extension if not exists "pgcrypto";

-- Función común para validar invariantes de actualización y evitar sobrescritura silenciosa
create or replace function public.verificar_control_version_sincronizacion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- El propietario jamás puede cambiar una vez creado el registro
  if NEW.propietario_id <> OLD.propietario_id then
    raise exception 'PROPIETARIO_INMUTABLE: No se permite transferir la propiedad del registro %', OLD.id;
  end if;

  -- Control de concurrencia optimista: una actualización debe incrementar la versión
  if NEW.version < OLD.version then
    raise exception 'CONFLICTO_VERSION: La versión entrante (%) es menor que la versión almacenada (%) en el registro %',
      NEW.version, OLD.version, OLD.id;
  end if;

  -- Conservar created_at original inmutable
  NEW.created_at := OLD.created_at;
  return NEW;
end;
$$;

-- Macro estructural repetida para las 9 entidades sincronizables de la fuente única de verdad:
-- 1. cuentas
-- 2. categorias
-- 3. eventos
-- 4. presupuestos
-- 5. transacciones
-- 6. gastos_planificados
-- 7. gastos_compartidos
-- 8. liquidaciones_compartidas
-- 9. reglas_recurrencia

create table if not exists public.cuentas_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.categorias_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.eventos_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.presupuestos_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.transacciones_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  fecha_movimiento text not null,
  tipo_movimiento text not null check (tipo_movimiento in ('INGRESO', 'GASTO', 'TRANSFERENCIA', 'SALDO_INICIAL')),
  monto_centimos bigint not null check (tipo_movimiento = 'SALDO_INICIAL' or monto_centimos > 0),
  moneda text not null default 'PEN' check (moneda = 'PEN'),
  origen text not null check (origen in ('MANUAL', 'IMPORTADO', 'SINCRONIZADO')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.gastos_planificados_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.gastos_compartidos_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.liquidaciones_compartidas_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

create table if not exists public.reglas_recurrencia_sync (
  id text not null,
  propietario_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  dispositivo_id text not null,
  version integer not null default 1 check (version >= 1),
  estado text not null default 'ACTIVO' check (estado in ('ACTIVO', 'ELIMINADO')),
  estado_sincronizacion text not null default 'SINCRONIZADO' check (estado_sincronizacion in ('PENDIENTE', 'SINCRONIZADO', 'CONFLICTO', 'ERROR')),
  huella_contenido text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  eliminado_en timestamptz null,
  datos jsonb not null,
  primary key (propietario_id, id)
);

-- Índices para sincronización incremental rápida por cursor (updated_at)
create index if not exists idx_cuentas_sync_updated on public.cuentas_sync (propietario_id, updated_at);
create index if not exists idx_categorias_sync_updated on public.categorias_sync (propietario_id, updated_at);
create index if not exists idx_eventos_sync_updated on public.eventos_sync (propietario_id, updated_at);
create index if not exists idx_presupuestos_sync_updated on public.presupuestos_sync (propietario_id, updated_at);
create index if not exists idx_transacciones_sync_updated on public.transacciones_sync (propietario_id, updated_at);
create index if not exists idx_gastos_planificados_sync_updated on public.gastos_planificados_sync (propietario_id, updated_at);
create index if not exists idx_gastos_compartidos_sync_updated on public.gastos_compartidos_sync (propietario_id, updated_at);
create index if not exists idx_liquidaciones_sync_updated on public.liquidaciones_compartidas_sync (propietario_id, updated_at);
create index if not exists idx_reglas_recurrencia_sync_updated on public.reglas_recurrencia_sync (propietario_id, updated_at);

-- Triggers de protección de versión e inmutabilidad de propietario
drop trigger if exists trg_version_cuentas_sync on public.cuentas_sync;
create trigger trg_version_cuentas_sync before update on public.cuentas_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_categorias_sync on public.categorias_sync;
create trigger trg_version_categorias_sync before update on public.categorias_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_eventos_sync on public.eventos_sync;
create trigger trg_version_eventos_sync before update on public.eventos_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_presupuestos_sync on public.presupuestos_sync;
create trigger trg_version_presupuestos_sync before update on public.presupuestos_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_transacciones_sync on public.transacciones_sync;
create trigger trg_version_transacciones_sync before update on public.transacciones_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_gastos_planificados_sync on public.gastos_planificados_sync;
create trigger trg_version_gastos_planificados_sync before update on public.gastos_planificados_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_gastos_compartidos_sync on public.gastos_compartidos_sync;
create trigger trg_version_gastos_compartidos_sync before update on public.gastos_compartidos_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_liquidaciones_sync on public.liquidaciones_compartidas_sync;
create trigger trg_version_liquidaciones_sync before update on public.liquidaciones_compartidas_sync
for each row execute function public.verificar_control_version_sincronizacion();

drop trigger if exists trg_version_reglas_recurrencia_sync on public.reglas_recurrencia_sync;
create trigger trg_version_reglas_recurrencia_sync before update on public.reglas_recurrencia_sync
for each row execute function public.verificar_control_version_sincronizacion();

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) ESTRICTO — USO PRIVADO EXCLUSIVO DEL PROPIETARIO
-- =============================================================================
alter table public.cuentas_sync enable row level security;
alter table public.cuentas_sync force row level security;

alter table public.categorias_sync enable row level security;
alter table public.categorias_sync force row level security;

alter table public.eventos_sync enable row level security;
alter table public.eventos_sync force row level security;

alter table public.presupuestos_sync enable row level security;
alter table public.presupuestos_sync force row level security;

alter table public.transacciones_sync enable row level security;
alter table public.transacciones_sync force row level security;

alter table public.gastos_planificados_sync enable row level security;
alter table public.gastos_planificados_sync force row level security;

alter table public.gastos_compartidos_sync enable row level security;
alter table public.gastos_compartidos_sync force row level security;

alter table public.liquidaciones_compartidas_sync enable row level security;
alter table public.liquidaciones_compartidas_sync force row level security;

alter table public.reglas_recurrencia_sync enable row level security;
alter table public.reglas_recurrencia_sync force row level security;

-- Revocar cualquier acceso anónimo o público
revoke all on all tables in schema public from anon, public;
grant select, insert, update on all tables in schema public to authenticated;

-- Políticas de aislamiento total por propietario (auth.uid() = propietario_id)
-- Nota: jamás se expone política alguna para el rol `anon`.
drop policy if exists rls_propietario_cuentas on public.cuentas_sync;
create policy rls_propietario_cuentas on public.cuentas_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_categorias on public.categorias_sync;
create policy rls_propietario_categorias on public.categorias_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_eventos on public.eventos_sync;
create policy rls_propietario_eventos on public.eventos_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_presupuestos on public.presupuestos_sync;
create policy rls_propietario_presupuestos on public.presupuestos_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_transacciones on public.transacciones_sync;
create policy rls_propietario_transacciones on public.transacciones_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_gastos_planificados on public.gastos_planificados_sync;
create policy rls_propietario_gastos_planificados on public.gastos_planificados_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_gastos_compartidos on public.gastos_compartidos_sync;
create policy rls_propietario_gastos_compartidos on public.gastos_compartidos_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_liquidaciones on public.liquidaciones_compartidas_sync;
create policy rls_propietario_liquidaciones on public.liquidaciones_compartidas_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);

drop policy if exists rls_propietario_reglas_recurrencia on public.reglas_recurrencia_sync;
create policy rls_propietario_reglas_recurrencia on public.reglas_recurrencia_sync
  for all to authenticated
  using (auth.uid() = propietario_id)
  with check (auth.uid() = propietario_id);
