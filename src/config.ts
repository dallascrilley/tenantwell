/**
 * Connection strings.
 *
 * Two distinct identities, on purpose:
 *
 *   ADMIN_DATABASE_URL - owns the schema, runs migrations, provisions test
 *                        databases. Superuser. Bypasses RLS. Never used to
 *                        serve a request.
 *   APP_DATABASE_URL   - the `tenantwell_app` role. Owns nothing, cannot
 *                        disable RLS, cannot bypass it. Every request path
 *                        uses this and only this.
 *
 * If those two ever collapse into one connection string, the isolation
 * guarantee is gone regardless of how good the policies are.
 */

const DEFAULT_HOST = process.env.PGHOST ?? "localhost";
const DEFAULT_PORT = process.env.PGPORT ?? "5433";

/** Throwaway local default only. Never reuse on a shared or long-lived cluster. */
const DEFAULT_APP_ROLE_PASSWORD = "tenantwell_app_local";

/**
 * Password for `tenantwell_app`. Prefer `APP_ROLE_PASSWORD`. If only
 * `APP_DATABASE_URL` is set, the password is taken from that URL so the
 * migrator's `ALTER ROLE` matches what the app will connect with.
 *
 * The password is deliberately NOT stored in migration SQL (see 0001).
 */
export const APP_ROLE_PASSWORD = (() => {
  if (process.env.APP_ROLE_PASSWORD) {
    return process.env.APP_ROLE_PASSWORD;
  }
  if (process.env.APP_DATABASE_URL) {
    try {
      const password = new URL(process.env.APP_DATABASE_URL).password;
      if (password) {
        return decodeURIComponent(password);
      }
    } catch {
      // Fall through to the local default.
    }
  }
  return DEFAULT_APP_ROLE_PASSWORD;
})();

export const ADMIN_DATABASE_URL =
  process.env.ADMIN_DATABASE_URL ??
  `postgres://postgres:postgres@${DEFAULT_HOST}:${DEFAULT_PORT}/tenantwell`;

export const APP_DATABASE_URL =
  process.env.APP_DATABASE_URL ??
  `postgres://tenantwell_app:${encodeURIComponent(APP_ROLE_PASSWORD)}@${DEFAULT_HOST}:${DEFAULT_PORT}/tenantwell`;

/** Swap the database name in a connection string, keeping credentials/host. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}
