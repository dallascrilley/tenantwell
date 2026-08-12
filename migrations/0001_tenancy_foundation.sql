-- 0001_tenancy_foundation.sql
--
-- Tenancy foundation:
--   * the least-privileged application role that every request runs as
--   * the tenants table
--   * the transaction-scoped tenant-context accessor
--
-- Everything downstream depends on app_current_tenant_id() being the ONLY
-- source of tenant identity. Application SQL never filters by tenant itself.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The application role. Deliberately:
--   * NOSUPERUSER  - superusers bypass RLS unconditionally
--   * NOBYPASSRLS  - the attribute that would silently defeat every policy
--   * NOCREATEROLE - cannot mint itself a more privileged identity
--   * not the owner of any table - so it cannot ALTER ... DISABLE ROW LEVEL SECURITY
--
-- Roles are cluster-scoped while migrations are per-database, so this block has
-- to be both re-runnable AND safe against two databases migrating at once. A
-- check-then-create would race; catching the duplicate is the only version that
-- actually holds. (The migration advisory lock does not help here: advisory
-- locks are scoped to one database.)
-- No password is set here on purpose. Baking a known password into a
-- migration file is a copy-paste footgun when these files land on a shared
-- cluster. The migrator (src/migrate.ts) sets the password from
-- APP_ROLE_PASSWORD / APP_DATABASE_URL after applying SQL. Local defaults
-- stay throwaway; production must supply its own.
DO $$
BEGIN
  CREATE ROLE tenantwell_app LOGIN
    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    NULL;
END
$$;

-- Re-assert the attributes that matter, whichever branch above ran. If someone
-- granted this role BYPASSRLS out of band, the next migration takes it back.
ALTER ROLE tenantwell_app NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;

GRANT USAGE ON SCHEMA public TO tenantwell_app;

-- Read the tenant bound to the current transaction.
--
-- current_setting(..., true) returns NULL when the GUC was never set, and the
-- app helper always sets it with is_local => true, so the value cannot leak
-- across pooled connections. An unbound transaction yields NULL, and every
-- policy below compares against it with `=`, which is NULL for every row.
-- That is the fail-closed default: no binding means no rows, never all rows.
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

REVOKE ALL ON FUNCTION app_current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO tenantwell_app;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
-- FORCE also applies the policy to the table owner. Without it, the migration
-- role would read every tenant's rows, and so would anything that happened to
-- connect as the owner.
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

GRANT SELECT ON tenants TO tenantwell_app;
