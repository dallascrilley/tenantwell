import type { TenantScopedClient } from "./tenant-context.js";

/**
 * The application data access layer.
 *
 * Note what is absent from every statement below: a `WHERE tenant_id = $n`
 * clause. That is the whole point. Tenant scoping is not something each query
 * remembers to do - it is something the database applies to every query,
 * including the ones nobody reviewed. A missing filter here is a bug; it is
 * not a data leak.
 */

export type Project = {
  id: string;
  tenantId: string;
  name: string;
};

export type Document = {
  id: string;
  tenantId: string;
  projectId: string;
  title: string;
  body: string;
};

export type Comment = {
  id: string;
  tenantId: string;
  documentId: string;
  author: string;
  body: string;
};

export async function listProjects(client: TenantScopedClient): Promise<Project[]> {
  const result = await client.query<{ id: string; tenant_id: string; name: string }>(
    "SELECT id, tenant_id, name FROM projects ORDER BY created_at",
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
  }));
}

export async function listDocuments(client: TenantScopedClient): Promise<Document[]> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    project_id: string;
    title: string;
    body: string;
  }>("SELECT id, tenant_id, project_id, title, body FROM documents ORDER BY created_at");
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
  }));
}

/** Fetch one document by primary key. Returns null when it belongs elsewhere. */
export async function findDocument(
  client: TenantScopedClient,
  documentId: string,
): Promise<Document | null> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    project_id: string;
    title: string;
    body: string;
  }>("SELECT id, tenant_id, project_id, title, body FROM documents WHERE id = $1", [documentId]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
  };
}

/**
 * Insert a document. `tenant_id` is taken from the transaction context, never
 * from caller input - a caller-supplied tenant_id is an authorization decision
 * disguised as a parameter.
 */
export async function createDocument(
  client: TenantScopedClient,
  input: { projectId: string; title: string; body?: string },
): Promise<Document> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    project_id: string;
    title: string;
    body: string;
  }>(
    `INSERT INTO documents (tenant_id, project_id, title, body)
     VALUES (app_current_tenant_id(), $1, $2, $3)
     RETURNING id, tenant_id, project_id, title, body`,
    [input.projectId, input.title, input.body ?? ""],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Insert returned no row");
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
  };
}

/** Rename a document. Returns the number of rows the caller was allowed to touch. */
export async function renameDocument(
  client: TenantScopedClient,
  documentId: string,
  title: string,
): Promise<number> {
  const result = await client.query("UPDATE documents SET title = $2 WHERE id = $1", [
    documentId,
    title,
  ]);
  return result.rowCount ?? 0;
}

export async function deleteDocument(
  client: TenantScopedClient,
  documentId: string,
): Promise<number> {
  const result = await client.query("DELETE FROM documents WHERE id = $1", [documentId]);
  return result.rowCount ?? 0;
}

export async function addComment(
  client: TenantScopedClient,
  input: { documentId: string; author: string; body: string },
): Promise<Comment> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    document_id: string;
    author: string;
    body: string;
  }>(
    `INSERT INTO comments (tenant_id, document_id, author, body)
     VALUES (app_current_tenant_id(), $1, $2, $3)
     RETURNING id, tenant_id, document_id, author, body`,
    [input.documentId, input.author, input.body],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Insert returned no row");
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    author: row.author,
    body: row.body,
  };
}

export async function listComments(client: TenantScopedClient): Promise<Comment[]> {
  const result = await client.query<{
    id: string;
    tenant_id: string;
    document_id: string;
    author: string;
    body: string;
  }>("SELECT id, tenant_id, document_id, author, body FROM comments ORDER BY created_at");
  return result.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    documentId: row.document_id,
    author: row.author,
    body: row.body,
  }));
}
