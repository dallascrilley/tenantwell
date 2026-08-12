-- 0002_workspace_domain.sql
--
-- A deliberately small, neutral domain: projects hold documents, documents hold
-- comments. Every table carries tenant_id as a first-class column, and every
-- table gets the same isolation policy. The point of the schema is to have
-- something to isolate, not to be interesting.
--
-- Two rules make the pattern hold under composition:
--
--   1. tenant_id is NOT NULL on every row-bearing table. A nullable tenant_id
--      is a row that no policy can classify.
--   2. Child rows reference their parent via a COMPOSITE foreign key that
--      includes tenant_id. A plain FK on project_id would let a caller attach
--      a document to another tenant's project if it ever obtained that id;
--      the composite FK makes that a database-level integrity error rather
--      than something RLS has to catch after the fact.

CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- the target of the composite FKs below
  UNIQUE (tenant_id, id)
);

CREATE INDEX projects_tenant_idx ON projects (tenant_id);

CREATE TABLE documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  project_id uuid NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE INDEX documents_tenant_idx ON documents (tenant_id);
CREATE INDEX documents_project_idx ON documents (tenant_id, project_id);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  document_id uuid NOT NULL,
  author      text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX comments_tenant_idx ON comments (tenant_id);
CREATE INDEX comments_document_idx ON comments (tenant_id, document_id);

-- One policy shape, applied uniformly. Applying it in a loop is what keeps a
-- table from being added later without a policy: the loop is the checklist.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['projects', 'documents', 'comments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant_id()) '
      'WITH CHECK (tenant_id = app_current_tenant_id())',
      target
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO tenantwell_app',
      target
    );
  END LOOP;
END
$$;

-- A guard against the most common way this pattern rots: someone adds a table
-- with a tenant_id column and forgets the policy. Also includes `tenants`,
-- which is isolated by `id = app_current_tenant_id()` rather than a
-- `tenant_id` column. Checked by the test suite rather than enforced at write
-- time, because CREATE TABLE cannot be intercepted without an event trigger
-- and superuser rights.
CREATE VIEW tenant_scoped_tables AS
SELECT
  c.relname                                             AS table_name,
  c.relrowsecurity                                      AS rls_enabled,
  c.relforcerowsecurity                                 AS rls_forced,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND (
    c.relname = 'tenants'
    OR EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = c.oid
        AND a.attname = 'tenant_id'
        AND NOT a.attisdropped
    )
  );
