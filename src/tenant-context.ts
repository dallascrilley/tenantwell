import type { Pool, PoolClient } from "pg";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`Tenant id ${JSON.stringify(value)} is not a UUID`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * A database handle that is already bound to one tenant for the life of a
 * transaction. Handed to callers instead of a raw client so that "am I inside
 * a tenant context?" is a type-level question rather than a convention.
 */
export type TenantScopedClient = {
  readonly tenantId: string;
  query: PoolClient["query"];
};

/**
 * Run `fn` inside a transaction whose tenant identity is bound to `tenantId`.
 *
 * The three properties that make this safe:
 *
 *  1. `set_config(..., is_local => true)` scopes the setting to the
 *     transaction. On COMMIT or ROLLBACK it is discarded, so a pooled
 *     connection cannot carry one tenant's identity into the next request.
 *     A session-level `SET` would leak exactly that way, and the leak is
 *     invisible until two tenants happen to land on the same connection.
 *
 *  2. The binding is the FIRST statement after BEGIN. Any query issued before
 *     it runs with a NULL tenant, which every policy treats as "no rows".
 *
 *  3. The value goes through a bind parameter, and is shape-checked first.
 *     `set_config` takes text, so a non-UUID would not fail until the policy
 *     casts it - and a cast error inside a policy is a confusing way to learn
 *     that your caller passed a username.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: TenantScopedClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const scoped: TenantScopedClient = {
      tenantId,
      query: client.query.bind(client) as PoolClient["query"],
    };

    try {
      const result = await fn(scoped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Read back the tenant Postgres believes the current transaction is acting as. */
export async function currentTenantId(client: TenantScopedClient): Promise<string | null> {
  const result = await client.query<{ tenant_id: string | null }>(
    "SELECT app_current_tenant_id() AS tenant_id",
  );
  return result.rows[0]?.tenant_id ?? null;
}
