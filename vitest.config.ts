import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],

    // Each test file provisions its own database, which keeps the proofs
    // independent. Files still run one at a time, because migration 0001 does
    // cluster-scoped DDL (CREATE ROLE / ALTER ROLE) and Postgres advisory
    // locks are database-scoped, so two databases migrating at the same
    // instant can collide on the shared role catalog. Serializing the files is
    // the honest fix; the whole suite runs in about a second either way.
    fileParallelism: false,

    // The first file has to create a database and apply migrations.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
