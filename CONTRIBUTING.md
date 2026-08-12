# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Setup

Requires Node 20+, pnpm 11 (pinned in `packageManager`), and Docker.

```bash
git clone https://github.com/dallascrilley/tenantwell.git
cd tenantwell
pnpm install
pnpm db:up        # Postgres 16 on host port 5433
pnpm test
```

Optional: copy `.env.example` if you want explicit connection strings. The
suite falls back to the documented local defaults when those variables are
unset.

## The checks CI runs

`.github/workflows/ci.yml` runs, in order:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

Run the same four locally before opening a pull request. CI uses a
GitHub-hosted Postgres 16 service on port 5432; local Docker Compose uses 5433
so it never collides with a host Postgres.

## What a good change looks like

- **Proofs stay honest.** The three files under `test/` are the product surface.
  If you change a policy, a binding, or the migration gate, update the matching
  proof and the README claim in the same change.
- **Do not invent a fourth identity.** Keep admin (migrations / ground truth)
  and `tenantwell_app` (every request path) separate.
- **Migrations are append-only.** Once applied, a file is immutable; the
  checksum gate will reject in-place edits. Add a new numbered file instead.
- **Passwords stay out of SQL.** Role passwords are set by the migrator from
  `APP_ROLE_PASSWORD` / `APP_DATABASE_URL`, not baked into `migrations/`.

## Scope

This is a small demonstration of a pattern. Prefer a focused patch over a
framework. There is no published npm package; `package.json` `exports` exist so
you can import the extract locally, not so it ships to a registry.
