-- ============================================================
-- NEXO · Esquema de base de datos para Supabase (PostgreSQL) — v2
-- Pegar COMPLETO en: proyecto → SQL Editor → Run.
-- Se puede ejecutar de nuevo sin perder datos (migra desde la v1).
--
-- Qué corrige respecto a la v1:
--  1) Seguridad real: cada persona solo ve lo de SU círculo
--     (antes cualquiera podía leer todos los grupos, códigos y posiciones).
--  2) Unirse por código con una función segura (buscar_grupo_por_codigo).
--  3) Activa Realtime en las tablas (sin esto la ubicación en vivo NO llega).
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- Tablas ----------
create table if not exists public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null default 'Usuario',
  telefono text default '',
  share_ubicacion boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.ubicaciones (
  usuario_id uuid primary key references public.perfiles (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.grupos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  descripcion text default '',
  codigo text not null unique,
  propietario_id uuid not null references public.perfiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.miembros (
  grupo_id uuid not null references public.grupos (id) on delete cascade,
  usuario_id uuid not null references public.perfiles (id) on delete cascade,
  rol text not null default 'MEMBER' check (rol in ('OWNER', 'ADMIN', 'MEMBER')),
  created_at timestamptz not null default now(),
  primary key (grupo_id, usuario_id)
);

create table if not exists public.lugares (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.perfiles (id) on delete cascade,
  nombre text not null,
  categoria text default 'Otro',
  direccion text default '',
  lat double precision not null,
  lng double precision not null,
  created_at timestamptz not null default now()
);

create table if not exists public.alertas (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos (id) on delete cascade,
  emisor_id uuid not null references public.perfiles (id) on delete cascade,
  mensaje text default '',
  lat double precision not null,
  lng double precision not null,
  estado text not null default 'ACTIVE' check (estado in ('ACTIVE', 'RESOLVED')),
  creada_en timestamptz not null default now(),
  resuelta_en timestamptz
);

create table if not exists public.notificaciones (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.perfiles (id) on delete cascade,
  tipo text not null default 'INFO',
  titulo text not null,
  cuerpo text default '',
  leida boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_grupos_codigo on public.grupos (codigo);
create index if not exists idx_miembros_usuario on public.miembros (usuario_id);
create index if not exists idx_alertas_grupo on public.alertas (grupo_id, estado);
create index if not exists idx_notificaciones_usuario on public.notificaciones (usuario_id);

-- ---------- Funciones auxiliares (SECURITY DEFINER evita recursión en las políticas) ----------

-- Ids de los grupos a los que pertenezco
create or replace function public.mis_grupos()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select grupo_id from public.miembros where usuario_id = auth.uid()
$$;

-- ¿Comparto algún círculo con esa persona? (o soy yo)
create or replace function public.comparte_circulo(otro uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select otro = auth.uid() or exists (
    select 1
    from public.miembros a
    join public.miembros b on a.grupo_id = b.grupo_id
    where a.usuario_id = auth.uid() and b.usuario_id = otro
  )
$$;

-- ¿Soy líder o co-líder de ese grupo?
create or replace function public.es_admin_de(gid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.miembros
    where grupo_id = gid and usuario_id = auth.uid() and rol in ('OWNER', 'ADMIN')
  ) or exists (
    select 1 from public.grupos where id = gid and propietario_id = auth.uid()
  )
$$;

-- Buscar un grupo por su código (la única forma de "descubrir" un grupo ajeno)
create or replace function public.buscar_grupo_por_codigo(p_codigo text)
returns table (
  id uuid, nombre text, descripcion text, codigo text,
  propietario_id uuid, created_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select g.id, g.nombre, g.descripcion, g.codigo, g.propietario_id, g.created_at
  from public.grupos g
  where g.codigo = upper(regexp_replace(coalesce(p_codigo, ''), '\s', '', 'g'))
  limit 1
$$;

revoke all on function public.mis_grupos() from public, anon;
revoke all on function public.comparte_circulo(uuid) from public, anon;
revoke all on function public.es_admin_de(uuid) from public, anon;
revoke all on function public.buscar_grupo_por_codigo(text) from public, anon;
grant execute on function public.mis_grupos() to authenticated;
grant execute on function public.comparte_circulo(uuid) to authenticated;
grant execute on function public.es_admin_de(uuid) to authenticated;
grant execute on function public.buscar_grupo_por_codigo(text) to authenticated;

-- ---------- Seguridad a nivel de fila (RLS) ----------
alter table public.perfiles enable row level security;
alter table public.ubicaciones enable row level security;
alter table public.grupos enable row level security;
alter table public.miembros enable row level security;
alter table public.lugares enable row level security;
alter table public.alertas enable row level security;
alter table public.notificaciones enable row level security;

-- Borra TODAS las políticas anteriores (v1 y v2) para empezar limpio
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('perfiles','ubicaciones','grupos','miembros','lugares','alertas','notificaciones')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- perfiles: yo y la gente de mis círculos
create policy "perfiles_ver" on public.perfiles for select to authenticated
  using (public.comparte_circulo(id));
create policy "perfiles_crear" on public.perfiles for insert to authenticated
  with check (id = auth.uid());
create policy "perfiles_editar" on public.perfiles for update to authenticated
  using (id = auth.uid());

-- ubicaciones: la mía y la de mis círculos
create policy "ubicaciones_ver" on public.ubicaciones for select to authenticated
  using (public.comparte_circulo(usuario_id));
create policy "ubicaciones_crear" on public.ubicaciones for insert to authenticated
  with check (usuario_id = auth.uid());
create policy "ubicaciones_editar" on public.ubicaciones for update to authenticated
  using (usuario_id = auth.uid());

-- grupos: solo los míos (para unirse se usa buscar_grupo_por_codigo)
create policy "grupos_ver" on public.grupos for select to authenticated
  using (propietario_id = auth.uid() or id in (select public.mis_grupos()));
create policy "grupos_crear" on public.grupos for insert to authenticated
  with check (propietario_id = auth.uid());
create policy "grupos_editar" on public.grupos for update to authenticated
  using (propietario_id = auth.uid());
create policy "grupos_borrar" on public.grupos for delete to authenticated
  using (propietario_id = auth.uid());

-- miembros
create policy "miembros_ver" on public.miembros for select to authenticated
  using (usuario_id = auth.uid() or grupo_id in (select public.mis_grupos()));
-- Unirme yo mismo como MEMBER; solo el dueño del grupo puede crear su fila OWNER
create policy "miembros_unirse" on public.miembros for insert to authenticated
  with check (
    usuario_id = auth.uid()
    and (
      rol = 'MEMBER'
      or exists (select 1 from public.grupos g where g.id = grupo_id and g.propietario_id = auth.uid())
    )
  );
create policy "miembros_salir_o_quitar" on public.miembros for delete to authenticated
  using (usuario_id = auth.uid() or public.es_admin_de(grupo_id));

-- lugares
create policy "lugares_ver" on public.lugares for select to authenticated
  using (public.comparte_circulo(usuario_id));
create policy "lugares_crear" on public.lugares for insert to authenticated
  with check (usuario_id = auth.uid());
create policy "lugares_editar" on public.lugares for update to authenticated
  using (usuario_id = auth.uid());
create policy "lugares_borrar" on public.lugares for delete to authenticated
  using (usuario_id = auth.uid());

-- alertas SOS
create policy "alertas_ver" on public.alertas for select to authenticated
  using (grupo_id in (select public.mis_grupos()));
create policy "alertas_crear" on public.alertas for insert to authenticated
  with check (emisor_id = auth.uid() and grupo_id in (select public.mis_grupos()));
create policy "alertas_resolver" on public.alertas for update to authenticated
  using (grupo_id in (select public.mis_grupos()));
create policy "alertas_borrar" on public.alertas for delete to authenticated
  using (emisor_id = auth.uid() or public.es_admin_de(grupo_id));

-- notificaciones: solo las mías; puedo enviar a gente de mis círculos
create policy "notif_enviar" on public.notificaciones for insert to authenticated
  with check (public.comparte_circulo(usuario_id));
create policy "notif_ver" on public.notificaciones for select to authenticated
  using (usuario_id = auth.uid());
create policy "notif_editar" on public.notificaciones for update to authenticated
  using (usuario_id = auth.uid());
create policy "notif_borrar" on public.notificaciones for delete to authenticated
  using (usuario_id = auth.uid());

-- ---------- Perfil automático al registrarse ----------
create or replace function public.crear_perfil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nombre', 'Usuario'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.crear_perfil();

-- Perfiles de usuarios que ya existían antes de este esquema
insert into public.perfiles (id, nombre)
select u.id, coalesce(u.raw_user_meta_data ->> 'nombre', 'Usuario')
from auth.users u
on conflict (id) do nothing;

-- ---------- Realtime (imprescindible para ver la ubicación en vivo) ----------
do $$ begin alter publication supabase_realtime add table public.ubicaciones;    exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.alertas;        exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.notificaciones; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.miembros;       exception when duplicate_object then null; end $$;
