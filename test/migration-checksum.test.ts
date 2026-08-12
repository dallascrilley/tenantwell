import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  MigrationChecksumError,
  runMigrations,
} from "../src/migrate.js";
import { provisionDatabase, type TestDatabase } from "./helpers/database.js";

/**
 * PROOF 3 - the migration checksum gate.
 *
 * The RLS policies live in migration files. If an applied migration can be
 * edited in place, source and database silently diverge: the repository shows
 * a policy that the running database never received. The gate turns that into
 * a startup failure.
 */
describe("proof 3: the migration checksum gate", () => {
  let db: TestDatabase;
  let workDir: string;

  beforeAll(async () => {
    // provisionDatabase already ran the real migrations once.
    db = await provisionDatabase("checksum");
    workDir = await mkdtemp(path.join(tmpdir(), "tenantwell-migrations-"));
    await cp(defaultMigrationsDirectory, workDir, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("records a sha256 per migration", async () => {
    const migrations = await loadMigrations(workDir);
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }

    const ledger = await db.admin.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    expect(ledger.rows.map((r) => r.name)).toEqual(migrations.map((m) => m.name));
    expect(ledger.rows.map((r) => r.checksum.trim())).toEqual(
      migrations.map((m) => m.checksum),
    );
  });

  it("is a no-op when nothing changed", async () => {
    const applied = await runMigrations({ connectionString: db.adminUrl, directory: workDir });
    expect(applied).toEqual([]);
  });

  it("rejects a tampered migration instead of silently skipping it", async () => {
    const target = path.join(workDir, "0002_workspace_domain.sql");
    const original = await readFile(target, "utf8");

    // The realistic attack: weaken a policy in a file that already ran. Without
    // the gate this is invisible - the runner sees the name in the ledger and
    // moves on, so the weakened policy never reaches any database while the
    // repository claims it is in force.
    const tampered = original.replace(
      "USING (tenant_id = app_current_tenant_id()) ",
      "USING (true) ",
    );
    expect(tampered).not.toBe(original);
    await writeFile(target, tampered, "utf8");

    try {
      await expect(
        runMigrations({ connectionString: db.adminUrl, directory: workDir }),
      ).rejects.toBeInstanceOf(MigrationChecksumError);
    } finally {
      await writeFile(target, original, "utf8");
    }
  });

  it("leaves the database untouched after rejecting a tampered migration", async () => {
    const policies = await db.admin.query<{ qual: string }>(
      `SELECT pg_get_expr(polqual, polrelid) AS qual
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'documents'`,
    );
    expect(policies.rowCount).toBe(1);
    expect(policies.rows[0]?.qual).toContain("app_current_tenant_id()");

    // and re-running the untampered set is still a clean no-op
    const applied = await runMigrations({ connectionString: db.adminUrl, directory: workDir });
    expect(applied).toEqual([]);
  });

  it("rejects a migration filename that does not sort deterministically", async () => {
    const strayDir = await mkdtemp(path.join(tmpdir(), "tenantwell-stray-"));
    try {
      await writeFile(path.join(strayDir, "add-policies.sql"), "SELECT 1;", "utf8");
      await expect(loadMigrations(strayDir)).rejects.toThrow(/expected NNNN_description\.sql/);
    } finally {
      await rm(strayDir, { recursive: true, force: true });
    }
  });
});
