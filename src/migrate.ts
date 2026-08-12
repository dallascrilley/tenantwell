import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { ADMIN_DATABASE_URL, APP_ROLE_PASSWORD } from "./config.js";

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

// Advisory lock coordinates concurrent deployers. Two app instances booting at
// once must not both try to apply 0003.
const MIGRATION_LOCK_NAMESPACE = 4_027_119;
const MIGRATION_LOCK_ID = 1;

export type Migration = {
  name: string;
  sql: string;
  checksum: string;
};

export class MigrationChecksumError extends Error {
  constructor(
    readonly migrationName: string,
    readonly appliedChecksum: string,
    readonly currentChecksum: string,
  ) {
    super(
      `Migration ${migrationName} has changed since it was applied ` +
        `(applied ${appliedChecksum.slice(0, 12)}..., now ${currentChecksum.slice(0, 12)}...). ` +
        `Migrations are immutable once applied; add a new migration instead.`,
    );
    this.name = "MigrationChecksumError";
  }
}

export const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function loadMigrations(
  directory: string = defaultMigrationsDirectory,
): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    // Lexicographic sort over zero-padded prefixes is the ordering contract.
    .sort();

  return Promise.all(
    sqlFiles.map(async (name) => {
      if (!MIGRATION_FILENAME.test(name)) {
        throw new Error(`Invalid migration filename ${name}; expected NNNN_description.sql`);
      }
      const sql = await readFile(path.join(directory, name), "utf8");
      return { name, sql, checksum: sha256(sql) };
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type RunMigrationsOptions = {
  connectionString?: string;
  directory?: string;
};

/**
 * Apply pending migrations, refusing to proceed if an already-applied
 * migration file has changed.
 *
 * Why the checksum gate matters for tenancy specifically: the RLS policies
 * live in migration files. If an applied migration can be edited in place, a
 * policy can be weakened in source, sail through review as "a migration we
 * already ran", and never actually reach production - so the code says one
 * thing and the database enforces another. The checksum makes that divergence
 * a hard failure at deploy time instead of a silent one.
 *
 * The gate is a consistency check, not an integrity check against a hostile
 * DBA: anyone who can write to `schema_migrations` can update the stored
 * checksum too. See "Honest boundaries" in the README.
 */
export async function runMigrations({
  connectionString = ADMIN_DATABASE_URL,
  directory = defaultMigrationsDirectory,
}: RunMigrationsOptions = {}): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  const client = new Client({ connectionString });
  const applied: string[] = [];
  let lockAcquired = false;

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [migration.name],
      );
      const appliedChecksum = existing.rows[0]?.checksum.trim();

      if (appliedChecksum) {
        if (appliedChecksum !== migration.checksum) {
          throw new MigrationChecksumError(migration.name, appliedChecksum, migration.checksum);
        }
        continue;
      }

      // Each migration is its own transaction: a failure leaves the schema at
      // the last complete migration rather than half-way through this one.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          migration.name,
          migration.checksum,
        ]);
        await client.query("COMMIT");
        applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    // Password lives outside migration SQL so the committed files never ship a
    // known credential. Re-applied on every migrate so APP_ROLE_PASSWORD and
    // APP_DATABASE_URL stay aligned with the role the app connects as.
    //
    // ALTER ROLE does not accept bind parameters (utility command). format(%L)
    // is the safe quoting path — never string-interpolate the password.
    const passwordSql = await client.query<{ sql: string }>(
      "SELECT format('ALTER ROLE tenantwell_app PASSWORD %L', $1::text) AS sql",
      [APP_ROLE_PASSWORD],
    );
    const alter = passwordSql.rows[0]?.sql;
    if (!alter) {
      throw new Error("Failed to build ALTER ROLE PASSWORD statement");
    }
    await client.query(alter);

    return applied;
  } finally {
    try {
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_ID,
        ]);
      }
    } finally {
      await client.end();
    }
  }
}
