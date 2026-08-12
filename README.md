# Tenantwell

**Postgres row level security multi-tenancy, with the isolation test that proves it.**

Most multi-tenant codebases enforce tenancy with a `WHERE tenant_id = $1` in
every query. That works until the one query that forgets it. Tenantwell moves
the boundary into the database: policies decide what a connection can see, the
application role has no way to turn them off, and a test suite demonstrates
that cross-tenant reads and writes are denied — including when the attacker
gets to write the SQL.

This is an architectural extract. The pattern is taken from a production system
I built; **the schema, the domain, and every row of data in this repository are
synthetic and written for this repository**. Nothing here is derived from real
records, and the tenants are named "Acme Tenant A" and "Beta Tenant B" for a
reason.

---

## The three proofs

The tests are the artifact. Each file corresponds to a claim, and each claim is
one someone should be skeptical of.

### Proof 1 — the application path denies cross-tenant access

`test/tenant-isolation.test.ts`

Two tenants are seeded. Tenant A then holds a **valid, correct primary key** for
one of tenant B's documents and asks for it through the ordinary repository
functions. Reads return nothing; writes affect nothing.

| Attempt (as tenant A, against tenant B's row) | Result |
| --- | --- |
| `findDocument(client, tenantB.documentId)` | `null` — while the row provably exists |
| `listDocuments` / `listProjects` / `listComments` | only tenant A's rows |
| `renameDocument(...)` | `0` rows affected |
| `deleteDocument(...)` | `0` rows affected |
| `INSERT` with a forged `tenant_id` | `42501` — `WITH CHECK` violation |
| `createDocument` into tenant B's project | `23503` — composite FK violation |

Two supporting properties are asserted in the same file, because the pattern is
worthless without them:

- The binding is **transaction-local**. After `withTenant` returns, the same
  pooled connection reports a `NULL` tenant. A session-level `SET` would leak
  one tenant's identity into the next request on that connection, and the leak
  would be invisible until two tenants happened to share a connection.
- An unbound transaction sees **zero rows**, not all rows. The
  `app_current_tenant_id()` helper collapses an unset *or previously-cleared*
  GUC (`current_setting` yields `NULL` or `''` depending on the connection's
  history) to `NULL`, and `tenant_id = NULL` is never true, so the default is
  fail-closed.

Read `src/repository.ts` and note what is missing from every statement: there
is no `WHERE tenant_id = ...` anywhere. That is the point — a forgotten filter
is a bug, not a breach.

### Proof 2 — raw SQL under the application role is denied too

`test/adversarial-sql.test.ts`

Proof 1 only shows the repository behaves, and a repository can be bypassed.
This file assumes the attacker **already has arbitrary SQL execution as the
application role** — a SQL injection that reached the driver, a compromised
service, a careless script — and asks whether isolation still holds.

| Attempt | Result |
| --- | --- |
| `SELECT * FROM documents` with no tenant bound | 0 rows |
| `SELECT * FROM documents` with tenant A bound | only tenant A's rows |
| `SELECT * FROM documents WHERE tenant_id = '<B>'` | 0 rows |
| `SELECT count(*) FROM documents` | `1`, while ground truth is `2` — no cardinality side channel |
| `JOIN comments` to reach rows through a child table | only tenant A's rows |
| `ALTER TABLE documents DISABLE ROW LEVEL SECURITY` | `42501` insufficient privilege |
| `DROP POLICY tenant_isolation ON documents` | `42501` |
| `CREATE POLICY wide_open ON documents USING (true)` | `42501` |
| `SET ROLE postgres` | `42501` |
| `ALTER ROLE tenantwell_app BYPASSRLS` | `42501` |
| `SELECT * FROM schema_migrations` | `42501` — never granted |

The suite also asserts the role's own attributes (`rolsuper`, `rolbypassrls`,
`rolcreaterole` all false) and walks `pg_class` / `pg_policy` to confirm every
table carrying a `tenant_id` has RLS **enabled**, **forced**, and at least one
policy. That last check is the one that catches the realistic future failure:
someone adds a table six months from now and forgets the policy.

The boundary is the role, not the code.

### Proof 3 — the migration checksum gate rejects a tampered migration

`test/migration-checksum.test.ts`

The policies live in migration files. If an applied migration can be edited in
place, source and database diverge silently: the repository shows a policy the
running database never received, and the diff sails through review as "a
migration we already ran."

The runner stores a SHA-256 per migration in `schema_migrations`. The test
copies the real migrations to a temp directory, applies them, then rewrites the
applied `0002` to weaken its policy from `tenant_id = app_current_tenant_id()`
to `true` — the exact edit an attacker or a careless refactor would make. The
next run throws `MigrationChecksumError` instead of skipping the file, and the
database is confirmed to still hold the original policy expression.

---

## How the pattern works

Three pieces, and all three are load-bearing.

**1. Two database identities** (`src/config.ts`). A superuser that owns the
schema and runs migrations, and `tenantwell_app` that serves every request.
The application role owns no tables — so it cannot `ALTER TABLE ... DISABLE ROW
LEVEL SECURITY` — and is explicitly `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`.
Superusers bypass RLS unconditionally; if these two identities ever collapse
into one connection string, the policies stop meaning anything.

**2. Transaction-scoped tenant binding** (`src/tenant-context.ts`).

```ts
await withTenant(pool, tenantId, async (client) => {
  return listDocuments(client); // no tenant filter anywhere
});
```

`withTenant` opens a transaction, makes
`SELECT set_config('app.tenant_id', $1, true)` the first statement, and hands
back a `TenantScopedClient`. The `true` is `is_local` — the setting dies with
the transaction, so a pooled connection cannot carry it forward. The tenant id
is shape-checked as a UUID before it is bound, so a caller who passes a
username gets an `InvalidTenantIdError` rather than a confusing cast error from
inside a policy.

**3. Uniform policies** (`migrations/`). Every tenant-scoped table gets:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
```

`FORCE` matters: without it the policy does not apply to the table's owner, so
anything connecting as the owner reads everything. `USING` governs what is
visible to reads, updates, and deletes; `WITH CHECK` governs what may be
written — omit it and a tenant can insert rows it will never be able to see
again, which is a quieter but real corruption.

Child rows use a **composite foreign key** that includes `tenant_id`
(`FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)`), so
attaching a document to another tenant's project is a database-level integrity
error rather than something RLS has to catch after the fact.

The synthetic domain is deliberately boring: `tenants` → `projects` →
`documents` → `comments`.

---

## Quickstart

Requires Node 20+, pnpm, and Docker. Every command below was run verbatim
against Postgres 16 while writing this README.

```bash
pnpm install
pnpm db:up        # docker compose up -d --wait  (Postgres 16 on host port 5433)
pnpm test
```

Expected output:

```
 ✓ test/adversarial-sql.test.ts (13 tests)
 ✓ test/tenant-isolation.test.ts (11 tests)
 ✓ test/migration-checksum.test.ts (5 tests)

 Test Files  3 passed (3)
      Tests  29 passed (29)
```

Applying migrations to the development database directly:

```bash
$ pnpm migrate
$ tsx src/cli.ts migrate
applied 0001_tenancy_foundation.sql
applied 0002_workspace_domain.sql

$ pnpm migrate
$ tsx src/cli.ts migrate
No pending migrations.
```

Poking at it by hand, as the application role:

```bash
$ docker compose exec -e PGPASSWORD=tenantwell_app_local postgres \
    psql -U tenantwell_app -d tenantwell \
    -c "select count(*) from documents;" \
    -c "select current_user, (select rolbypassrls from pg_roles where rolname=current_user);"
 count
-------
     0
(1 row)

  current_user  | rolbypassrls
----------------+--------------
 tenantwell_app | f
(1 row)
```

Zero rows with no tenant bound, from a role that cannot bypass RLS. That is the
whole idea in one command.

Tear down with `pnpm db:down`.

Other scripts: `pnpm typecheck`, `pnpm build`, `pnpm test:watch`.

**Configuration.** `ADMIN_DATABASE_URL` and `APP_DATABASE_URL` (or `PGHOST` /
`PGPORT`) override the defaults; see `.env.example`. The credentials in this
repository are throwaway values for a disposable local container.

Each test file provisions and drops its own database, so the suite leaves
nothing behind. Files run one at a time — migration `0001` does cluster-scoped
role DDL, and Postgres advisory locks are database-scoped, so two databases
migrating simultaneously can collide on the shared role catalog.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and the full suite
against a `services: postgres` container on GitHub-hosted runners.

---

## Honest boundaries

What this repository does **not** claim.

- **RLS is not a substitute for authorization.** It answers "which tenant's
  rows is this transaction allowed to touch." It says nothing about whether
  *this user* should see *this document* within their own tenant. Per-user
  permissions are a separate layer, and putting them in policies too gets
  expensive and hard to reason about fast.

- **Whoever binds the tenant decides everything.** `app.tenant_id` is a plain
  GUC, not a secret, and code running as the app role can rebind it — proof 2
  includes a test asserting exactly that, because the alternative would be
  pretending otherwise. The real guarantee is narrower and more useful: an
  attacker cannot turn the policy **off**, cannot escalate to a role that
  bypasses it, and cannot see anything without naming a tenant. Deriving the
  tenant id from a verified session at the edge — never from a request
  parameter — is still your job.

- **Superusers bypass RLS. Always.** The guarantee holds for `tenantwell_app`
  and only for it. A migration job, an admin console, a `psql` session as the
  owner, or a backup process reads everything. Keep that list short and audited.

- **The checksum gate is a consistency check, not tamper-proofing.** It catches
  an applied migration being edited in place, which is the common real failure.
  It does not defend against someone who can write to `schema_migrations`
  directly — they can update the stored hash too.

- **`FORCE ROW LEVEL SECURITY` is required, not optional.** Without it the
  owner is exempt, and "the tests passed as superuser" is how that gets missed.
  The suite asserts `relforcerowsecurity` on every tenant-scoped table.

- **Performance is not addressed here.** Policy predicates run per row and
  compose with your `WHERE` clauses; on large tables they interact with index
  selection in ways worth measuring. The indexes here lead with `tenant_id`,
  which is the right starting shape, but no benchmark is included and none is
  claimed.

- **A new table is a new hole.** Nothing prevents adding a table with a
  `tenant_id` and no policy. The `tenant_scoped_tables` view plus the test in
  proof 2 turn that into a red build, which is the best available answer short
  of an event trigger and superuser rights.

- **This is a demonstration of a pattern, not a library.** It is small enough
  to read in full and copy from. There is no published package.

## License

MIT — Copyright (c) 2026 Dallas Crilley. See [LICENSE](LICENSE).
