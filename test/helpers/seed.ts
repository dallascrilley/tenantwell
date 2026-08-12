import type { Pool } from "pg";

/**
 * Fixture data. Every value here is invented for this repository - two
 * obviously-fictional tenants with obviously-fictional content. Nothing in
 * this file corresponds to a real organization, person, or record.
 */

export const TENANT_A_ID = "11111111-1111-4111-8111-111111111111";
export const TENANT_B_ID = "22222222-2222-4222-8222-222222222222";

export type SeededFixture = {
  tenantA: { id: string; projectId: string; documentId: string };
  tenantB: { id: string; projectId: string; documentId: string };
};

const PROJECT_A_ID = "aaaa1111-0000-4000-8000-000000000001";
const PROJECT_B_ID = "bbbb2222-0000-4000-8000-000000000001";
const DOCUMENT_A_ID = "aaaa1111-0000-4000-8000-000000000002";
const DOCUMENT_B_ID = "bbbb2222-0000-4000-8000-000000000002";

/**
 * Seeds through the superuser pool, which bypasses RLS. That is intentional:
 * the fixtures need to create rows for two tenants at once, which no
 * tenant-scoped path is permitted to do. The tests then run exclusively
 * through the app role.
 */
export async function seedTwoTenants(admin: Pool): Promise<SeededFixture> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'acme-tenant-a', 'Acme Tenant A'),
       ($2, 'beta-tenant-b', 'Beta Tenant B')`,
    [TENANT_A_ID, TENANT_B_ID],
  );

  await admin.query(
    `INSERT INTO projects (id, tenant_id, name) VALUES
       ($1, $3, 'Alpha Workspace'),
       ($2, $4, 'Bravo Workspace')`,
    [PROJECT_A_ID, PROJECT_B_ID, TENANT_A_ID, TENANT_B_ID],
  );

  await admin.query(
    `INSERT INTO documents (id, tenant_id, project_id, title, body) VALUES
       ($1, $3, $5, 'Tenant A Runbook', 'Placeholder body owned by Acme Tenant A.'),
       ($2, $4, $6, 'Tenant B Runbook', 'Placeholder body owned by Beta Tenant B.')`,
    [DOCUMENT_A_ID, DOCUMENT_B_ID, TENANT_A_ID, TENANT_B_ID, PROJECT_A_ID, PROJECT_B_ID],
  );

  await admin.query(
    `INSERT INTO comments (tenant_id, document_id, author, body) VALUES
       ($1, $3, 'ada@acme-tenant-a.example', 'First note from tenant A.'),
       ($2, $4, 'bo@beta-tenant-b.example', 'First note from tenant B.')`,
    [TENANT_A_ID, TENANT_B_ID, DOCUMENT_A_ID, DOCUMENT_B_ID],
  );

  return {
    tenantA: { id: TENANT_A_ID, projectId: PROJECT_A_ID, documentId: DOCUMENT_A_ID },
    tenantB: { id: TENANT_B_ID, projectId: PROJECT_B_ID, documentId: DOCUMENT_B_ID },
  };
}
