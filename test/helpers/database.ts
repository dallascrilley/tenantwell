import { Client, Pool } from "pg";
import { ADMIN_DATABASE_URL, APP_DATABASE_URL, withDatabase } from "../../src/config.js";
import { runMigrations } from "../../src/migrate.js";

/**
 * Each test file provisions its own database so the suite can run in parallel
 * and so a test that corrupts state cannot corrupt a sibling.
 */
export type TestDatabase = {
  name: string;
  adminUrl: string;
  appUrl: string;
  /** Superuser pool. Bypasses RLS. Used only for seeding and for assertions
   *  about ground truth - never to represent an application request. */
  admin: Pool;
  /** The `tenantwell_app` role. Everything a request would do goes here. */
  app: Pool;
  drop: () => Promise<void>;
};

export async function provisionDatabase(label: string): Promise<TestDatabase> {
  const name = `tenantwell_test_${label}_${process.pid}_${Date.now().toString(36)}`;
  const bootstrapUrl = withDatabase(ADMIN_DATABASE_URL, "postgres");

  const bootstrap = new Client({ connectionString: bootstrapUrl });
  await bootstrap.connect();
  try {
    await bootstrap.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    await bootstrap.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await bootstrap.end();
  }

  const adminUrl = withDatabase(ADMIN_DATABASE_URL, name);
  const appUrl = withDatabase(APP_DATABASE_URL, name);

  await runMigrations({ connectionString: adminUrl });

  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  const app = new Pool({ connectionString: appUrl, max: 4 });

  return {
    name,
    adminUrl,
    appUrl,
    admin,
    app,
    drop: async () => {
      await admin.end();
      await app.end();
      const cleanup = new Client({ connectionString: bootstrapUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

function quoteIdent(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Refusing to use ${value} as an identifier`);
  }
  return `"${value}"`;
}
