import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InfraiClient } from "./infrai_client.ts";

export const auditRequestSchema = z.object({
  reviewDate: z.string().date(),
  temporaryKeyName: z.string().min(1),
  projectId: z.string().optional()
});
export type AuditRequest = z.infer<typeof auditRequestSchema>;

export type KeyReach = { id: string; name: string; scopes: string[] };
export type AuditResult = { reviewedOn: string; keys: KeyReach[]; reviewDocument: unknown };

function keyRows(data: unknown): KeyReach[] {
  const { items } = z.object({ items: z.array(z.object({
    key_id: z.string(), name: z.string(), scopes: z.array(z.string()).default([]), status: z.string().optional()
  })) }).parse(data);
  return items.map((row) => ({ id: row.key_id, name: row.name, scopes: row.scopes }));
}

export async function auditDeveloperKeys(client: InfraiClient, input: AuditRequest): Promise<AuditResult> {
  const request = auditRequestSchema.parse(input);
  const current = keyRows(await client.request("/account/keys/list", "GET"));
  if (current.some((key) => key.name === request.temporaryKeyName)) {
    throw new Error("Temporary key name must be unique to this run.");
  }
  const runId = randomUUID();
  const temporary = await client.request("/account/keys/create", "POST", {
    project_id: request.projectId, name: request.temporaryKeyName, scopes: ["account.keys.list"], idempotency_key: `audit-${runId}`
  }) as { key_id?: string };
  if (!temporary.key_id) throw new Error("temporary key id is required for the rotation exercise");
  if (current.some((key) => key.id === temporary.key_id)) {
    throw new Error("Refusing to modify a key that existed before this run.");
  }
  const temporaryId = encodeURIComponent(temporary.key_id);
  try {
    await client.request(`/account/keys/rotate/${temporaryId}`, "POST", { grace_hours: 1, idempotency_key: `rotate-${runId}` });
  } finally {
    // Rotation returns a different ID representation; use the list's revocable IDs.
    const created = keyRows(await client.request("/account/keys/list", "GET"))
      .filter((key) => key.name === request.temporaryKeyName && !current.some((old) => old.id === key.id));
    const cleanupIds = new Set([temporary.key_id, ...created.map((key) => key.id)]);
    const failures: unknown[] = [];
    for (const id of cleanupIds) {
      try {
        await client.request(`/account/keys/revoke/${encodeURIComponent(id)}`, "DELETE");
      } catch (error) {
        failures.push(error);
      }
    }
    const remaining = z.object({ items: z.array(z.object({ key_id: z.string(), name: z.string().optional(), status: z.string().optional() })) }).parse(await client.request("/account/keys/list", "GET"));
    if (remaining.items.some((key) => (cleanupIds.has(key.key_id) || key.name === request.temporaryKeyName) && key.status !== "revoked")) {
      throw new Error(`Temporary key cleanup could not be verified: ${request.temporaryKeyName}`);
    }
    if (failures.length) throw new AggregateError(failures, "Temporary key revocation failed");
  }
  const html = `<h1>Developer key access review</h1><p>Date: ${request.reviewDate}</p><ul>${current.map((key) => `<li>${key.name}: ${key.scopes.join(", ")}</li>`).join("")}</ul>`;
  const reviewDocument = await client.request("/pdf/generate", "POST", { html, page_size: "A4", orientation: "portrait", store: false });
  return { reviewedOn: request.reviewDate, keys: current, reviewDocument };
}

async function main(): Promise<void> {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before running the audit.");
  const result = await auditDeveloperKeys(new InfraiClient(key), { reviewDate: new Date().toISOString().slice(0, 10), temporaryKeyName: `access-review-temporary-${randomUUID()}` });
  console.log(JSON.stringify({ reviewedOn: result.reviewedOn, keys: result.keys, documentCreated: Boolean(result.reviewDocument) }, null, 2));
  console.log("The disposable key was revoked; its plaintext credentials are discarded.");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
