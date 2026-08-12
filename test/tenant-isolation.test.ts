import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addComment,
  createDocument,
  deleteDocument,
  findDocument,
  listComments,
  listDocuments,
  listProjects,
  renameDocument,
} from "../src/repository.js";
import { currentTenantId, InvalidTenantIdError, withTenant } from "../src/tenant-context.js";
import { provisionDatabase, type TestDatabase } from "./helpers/database.js";
import { seedTwoTenants, type SeededFixture } from "./helpers/seed.js";

/**
 * PROOF 1 - the application path.
 *
 * Tenant A holds a valid, correct id for one of tenant B's rows and asks for
 * it directly through the normal repository functions. Every read returns
 * nothing and every write affects nothing.
 */
describe("proof 1: cross-tenant reads and writes through the app path", () => {
  let db: TestDatabase;
  let fixture: SeededFixture;

  beforeAll(async () => {
    db = await provisionDatabase("isolation");
    fixture = await seedTwoTenants(db.admin);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it("binds the tenant for the life of the transaction", async () => {
    const bound = await withTenant(db.app, fixture.tenantA.id, (client) =>
      currentTenantId(client),
    );
    expect(bound).toBe(fixture.tenantA.id);
  });

  it("discards the binding when the transaction ends", async () => {
    await withTenant(db.app, fixture.tenantA.id, async () => undefined);

    // Same pool, likely the same physical connection. A session-level SET
    // would still be visible here.
    const leaked = await db.app.query<{ tenant_id: string | null }>(
      "SELECT app_current_tenant_id() AS tenant_id",
    );
    expect(leaked.rows[0]?.tenant_id).toBeNull();
  });

  it("lists only the acting tenant's projects and documents", async () => {
    const asA = await withTenant(db.app, fixture.tenantA.id, async (client) => ({
      projects: await listProjects(client),
      documents: await listDocuments(client),
      comments: await listComments(client),
    }));

    expect(asA.projects.map((p) => p.name)).toEqual(["Alpha Workspace"]);
    expect(asA.documents.map((d) => d.title)).toEqual(["Tenant A Runbook"]);
    expect(asA.comments).toHaveLength(1);
    expect(asA.documents.every((d) => d.tenantId === fixture.tenantA.id)).toBe(true);

    const asB = await withTenant(db.app, fixture.tenantB.id, async (client) => ({
      projects: await listProjects(client),
      documents: await listDocuments(client),
    }));
    expect(asB.projects.map((p) => p.name)).toEqual(["Bravo Workspace"]);
    expect(asB.documents.map((d) => d.title)).toEqual(["Tenant B Runbook"]);
  });

  it("cannot read another tenant's row by primary key", async () => {
    const found = await withTenant(db.app, fixture.tenantA.id, (client) =>
      findDocument(client, fixture.tenantB.documentId),
    );
    expect(found).toBeNull();

    // ... and the row genuinely exists.
    const groundTruth = await db.admin.query("SELECT id FROM documents WHERE id = $1", [
      fixture.tenantB.documentId,
    ]);
    expect(groundTruth.rowCount).toBe(1);
  });

  it("cannot read another tenant's row from the tenants table", async () => {
    // tenants is isolated on `id = app_current_tenant_id()`, not a tenant_id
    // column. Prove that shape is enforced, not only the child tables.
    const rows = await withTenant(db.app, fixture.tenantA.id, async (client) => {
      const result = await client.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM tenants ORDER BY slug",
      );
      return result.rows;
    });
    expect(rows).toEqual([{ id: fixture.tenantA.id, slug: "acme-tenant-a" }]);

    const groundTruth = await db.admin.query("SELECT count(*)::int AS n FROM tenants");
    expect(groundTruth.rows[0]?.n).toBe(2);
  });

  it("cannot update another tenant's row", async () => {
    const affected = await withTenant(db.app, fixture.tenantA.id, (client) =>
      renameDocument(client, fixture.tenantB.documentId, "Renamed by tenant A"),
    );
    expect(affected).toBe(0);

    const after = await db.admin.query<{ title: string }>(
      "SELECT title FROM documents WHERE id = $1",
      [fixture.tenantB.documentId],
    );
    expect(after.rows[0]?.title).toBe("Tenant B Runbook");
  });

  it("cannot delete another tenant's row", async () => {
    const affected = await withTenant(db.app, fixture.tenantA.id, (client) =>
      deleteDocument(client, fixture.tenantB.documentId),
    );
    expect(affected).toBe(0);

    const after = await db.admin.query("SELECT id FROM documents WHERE id = $1", [
      fixture.tenantB.documentId,
    ]);
    expect(after.rowCount).toBe(1);
  });

  it("cannot attach a new document to another tenant's project", async () => {
    // The insert takes tenant_id from the transaction context, so the row would
    // be tenant A's while project_id points at tenant B's project. The
    // composite foreign key rejects it before RLS is even consulted.
    await expect(
      withTenant(db.app, fixture.tenantA.id, (client) =>
        createDocument(client, {
          projectId: fixture.tenantB.projectId,
          title: "Smuggled document",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
  });

  it("rejects an insert that forges another tenant's tenant_id", async () => {
    await expect(
      withTenant(db.app, fixture.tenantA.id, (client) =>
        client.query(
          "INSERT INTO documents (tenant_id, project_id, title) VALUES ($1, $2, $3)",
          [fixture.tenantB.id, fixture.tenantB.projectId, "Forged document"],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" }); // WITH CHECK violation
  });

  it("cannot comment on another tenant's document", async () => {
    await expect(
      withTenant(db.app, fixture.tenantA.id, (client) =>
        addComment(client, {
          documentId: fixture.tenantB.documentId,
          author: "ada@acme-tenant-a.example",
          body: "Trying to reach tenant B.",
        }),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("writes made by one tenant are invisible to the other", async () => {
    const created = await withTenant(db.app, fixture.tenantA.id, (client) =>
      createDocument(client, {
        projectId: fixture.tenantA.projectId,
        title: "Tenant A private note",
      }),
    );
    expect(created.tenantId).toBe(fixture.tenantA.id);

    const seenByB = await withTenant(db.app, fixture.tenantB.id, (client) =>
      findDocument(client, created.id),
    );
    expect(seenByB).toBeNull();
  });

  it("refuses a tenant id that is not a UUID before touching the database", async () => {
    await expect(
      withTenant(db.app, "' OR true --", async () => "unreachable"),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });
});
