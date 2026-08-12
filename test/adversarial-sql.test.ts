import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionDatabase, type TestDatabase } from "./helpers/database.js";
import { seedTwoTenants, type SeededFixture } from "./helpers/seed.js";

/**
 * PROOF 2 - the adversarial path.
 *
 * Proof 1 shows the repository functions behave. That is the weaker claim: a
 * repository can be bypassed. This file assumes the attacker already has
 * arbitrary SQL execution as the application role - a SQL injection that
 * reached the driver, a compromised service, a careless script - and asks
 * whether tenant isolation still holds.
 *
 * It does. The boundary is the role, not the code.
 */
describe("proof 2: raw SQL under the application role", () => {
  let db: TestDatabase;
  let fixture: SeededFixture;

  beforeAll(async () => {
    db = await provisionDatabase("adversarial");
    fixture = await seedTwoTenants(db.admin);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it("the app role holds none of the attributes that would defeat RLS", async () => {
    const result = await db.app.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      current_role_name: string;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolname AS current_role_name
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(result.rows[0]).toMatchObject({
      current_role_name: "tenantwell_app",
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
    });
  });

  it("every tenant-scoped table has RLS enabled, forced, and a policy", async () => {
    const result = await db.admin.query<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: string;
    }>("SELECT * FROM tenant_scoped_tables ORDER BY table_name");

    expect(result.rows.map((r) => r.table_name)).toEqual(["comments", "documents", "projects"]);
    for (const row of result.rows) {
      expect(row.rls_enabled, `${row.table_name} RLS enabled`).toBe(true);
      expect(row.rls_forced, `${row.table_name} RLS forced`).toBe(true);
      expect(Number(row.policy_count), `${row.table_name} policy count`).toBeGreaterThan(0);
    }
  });

  it("an unbound transaction sees nothing at all (fail-closed)", async () => {
    // No set_config. The naive failure mode - policy compares against NULL and
    // "helpfully" returns everything - does not happen: NULL comparison is not
    // true, so no row qualifies.
    const documents = await db.app.query("SELECT * FROM documents");
    const projects = await db.app.query("SELECT * FROM projects");
    const comments = await db.app.query("SELECT * FROM comments");

    expect(documents.rowCount).toBe(0);
    expect(projects.rowCount).toBe(0);
    expect(comments.rowCount).toBe(0);
  });

  it("an unfiltered SELECT returns only the bound tenant's rows", async () => {
    const rows = await asTenant(db, fixture.tenantA.id, async (client) => {
      const result = await client.query<{ tenant_id: string; title: string }>(
        "SELECT tenant_id, title FROM documents",
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(fixture.tenantA.id);
  });

  it("explicitly asking for another tenant's rows returns zero rows", async () => {
    const rows = await asTenant(db, fixture.tenantA.id, async (client) => {
      const result = await client.query("SELECT * FROM documents WHERE tenant_id = $1", [
        fixture.tenantB.id,
      ]);
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("aggregates cannot count rows the tenant cannot see", async () => {
    // Aggregates are a classic side channel: SELECT count(*) leaks cardinality
    // even when the rows themselves are hidden. RLS applies before aggregation,
    // so it does not leak here.
    const total = await asTenant(db, fixture.tenantA.id, async (client) => {
      const result = await client.query<{ count: string }>("SELECT count(*) FROM documents");
      return Number(result.rows[0]?.count);
    });
    expect(total).toBe(1);

    const groundTruth = await db.admin.query<{ count: string }>("SELECT count(*) FROM documents");
    expect(Number(groundTruth.rows[0]?.count)).toBe(2);
  });

  it("a join cannot pull another tenant's rows in through a child table", async () => {
    const rows = await asTenant(db, fixture.tenantA.id, async (client) => {
      const result = await client.query(
        `SELECT d.title, c.body
           FROM documents d
           JOIN comments c ON c.document_id = d.id`,
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Tenant A Runbook" });
  });

  it("CAN rebind the tenant context to another tenant — the documented limitation", async () => {
    // Rebinding is allowed - the GUC is not privileged - but it is not an
    // escalation: the attacker must already know a tenant id, and the far more
    // important property is that they cannot turn the policy OFF. This test
    // documents the real boundary rather than pretending the GUC is a secret.
    // See "Honest boundaries" in the README.
    const rows = await asTenant(db, fixture.tenantA.id, async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.tenantB.id]);
      const result = await client.query("SELECT title FROM documents");
      return result.rows;
    });
    expect(rows).toMatchObject([{ title: "Tenant B Runbook" }]);
  });

  it("cannot disable row level security", async () => {
    await expect(
      db.app.query("ALTER TABLE documents DISABLE ROW LEVEL SECURITY"),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege
  });

  it("cannot drop the isolation policy", async () => {
    await expect(
      db.app.query("DROP POLICY tenant_isolation ON documents"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot create a permissive policy of its own", async () => {
    await expect(
      db.app.query("CREATE POLICY wide_open ON documents USING (true)"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot escalate to a role that bypasses RLS", async () => {
    await expect(db.app.query("SET ROLE postgres")).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.app.query("ALTER ROLE tenantwell_app BYPASSRLS"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot read the migration ledger it was never granted", async () => {
    await expect(db.app.query("SELECT * FROM schema_migrations")).rejects.toMatchObject({
      code: "42501",
    });
  });
});

/** Raw transaction as the app role, tenant bound, no repository layer involved. */
async function asTenant<T>(
  db: TestDatabase,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } finally {
    client.release();
  }
}
