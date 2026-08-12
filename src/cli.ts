#!/usr/bin/env node
import { runMigrations } from "./migrate.js";

const [command = "migrate"] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command !== "migrate") {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: tenantwell migrate");
    process.exitCode = 2;
    return;
  }

  const applied = await runMigrations();
  if (applied.length === 0) {
    console.log("No pending migrations.");
    return;
  }
  for (const name of applied) {
    console.log(`applied ${name}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
