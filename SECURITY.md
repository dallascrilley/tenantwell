# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/dallascrilley/tenantwell/security/advisories/new),
or by email to dallas@dallascrilley.com. Please do not open a public issue for
a security problem.

Include the affected commit, what you believe the impact is, and steps to
reproduce it. I aim to acknowledge within seven days and to say whether the
report is accepted, with a rough timeline for a fix.

## Supported versions

This project is pre-1.0 and single-branch. Only `main` receives security fixes.

## What this repository is

Tenantwell is an architectural extract that demonstrates Postgres row-level
security multi-tenancy. It is a pattern to read and copy from, not a hosted
product and not a published package.

## Security-relevant configuration

| Surface | Why it matters |
| --- | --- |
| `ADMIN_DATABASE_URL` | Superuser. Owns the schema, runs migrations, bypasses RLS. Never use it to serve a request. |
| `APP_DATABASE_URL` | Least-privileged `tenantwell_app` role. Every request path must use this and only this. |
| `APP_ROLE_PASSWORD` | Sets the app role password at migrate time. Not stored in migration SQL so a copy of `migrations/` does not install a known credential. |

Local defaults in `.env.example` and the migrator are throwaway credentials for
a disposable Docker Postgres. Do not reuse them on a shared or long-lived
cluster. Supply your own admin and app passwords before applying the pattern
anywhere that holds real data.

## Trust boundary (short)

- RLS answers "which tenant's rows may this transaction touch." It is not
  per-user authorization inside a tenant.
- Whoever binds `app.tenant_id` decides everything. Derive it from a verified
  session at the edge, never from a request parameter. The suite documents that
  the app role can rebind the GUC; the real guarantee is that it cannot turn
  policies off or escalate to a bypass role.
- Superusers always bypass RLS. Keep migration, admin, and backup identities
  short and audited.

See "Honest boundaries" in [README.md](README.md) for the full list of claims
this repository deliberately does not make.
