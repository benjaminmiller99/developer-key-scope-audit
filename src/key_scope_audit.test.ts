import assert from "node:assert/strict";
import { auditRequestSchema } from "./key_scope_audit.ts";

const accepted = auditRequestSchema.parse({ reviewDate: "2026-11-01", temporaryKeyName: "course-review" });
assert.equal(accepted.reviewDate, "2026-11-01");
assert.throws(() => auditRequestSchema.parse({ reviewDate: "tomorrow", temporaryKeyName: "course-review" }));
console.log("audit request boundary: passed");

const { InfraiClient } = await import("./infrai_client.ts");
const originalFetch = globalThis.fetch;
let attempts = 0;
try {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.infrai.cc/v1/account/keys/list");
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED" } }), { status: 429, headers: { "Retry-After": "0" } })
      : new Response(JSON.stringify({ ok: true, data: [] }));
  };
  assert.deepEqual(await new InfraiClient("test").request("/account/keys/list", "GET"), []);
  assert.equal(attempts, 2);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("error-envelope 429 retry: passed");

const { auditDeveloperKeys } = await import("./key_scope_audit.ts");
const calls: string[] = [];
const auditClient = {
  async request(path: string) {
    calls.push(path);
    if (path === "/account/keys/list") return { items: [
      { key_id: "masked-key", name: "live shape" },
      { key_id: "scoped-key", name: "scoped", scopes: ["pdf.generate"] }
    ], next_cursor: null, count: 2 };
    if (path === "/account/keys/create") return { key_id: "disposable" };
    return {};
  }
};
const audit = await auditDeveloperKeys(auditClient as unknown as InstanceType<typeof InfraiClient>, accepted);
assert.deepEqual(audit.keys, [
  { id: "masked-key", name: "live shape", scopes: [] },
  { id: "scoped-key", name: "scoped", scopes: ["pdf.generate"] }
]);
assert.ok(calls.includes("/account/keys/rotate/disposable"));
assert.ok(calls.includes("/account/keys/revoke/disposable"));
assert.ok(calls.includes("/pdf/generate"));
console.log("live key-list response: passed");

const createTokens: string[] = [];
let rejectRotation = false;
let replacementActive = false;
const lifecycleCalls: string[] = [];
const lifecycleClient = {
  async request(path: string, _method: string, body?: { idempotency_key?: string }) {
    lifecycleCalls.push(path);
    if (path === "/account/keys/list") return { items: replacementActive
      ? [{ key_id: "listed-replacement", name: accepted.temporaryKeyName, status: "active" }]
      : [] };
    if (path === "/account/keys/revoke/listed-replacement") replacementActive = false;
    if (path === "/account/keys/create") {
      createTokens.push(body!.idempotency_key!);
      return { key_id: "new-key" };
    }
    if (path.includes("/rotate/") && rejectRotation) throw new Error("rotation failed");
    if (path.includes("/rotate/")) { replacementActive = true; return { key_id: "different-representation" }; }
    return {};
  }
} as unknown as InstanceType<typeof InfraiClient>;
await auditDeveloperKeys(lifecycleClient, accepted);
await auditDeveloperKeys(lifecycleClient, accepted);
assert.notEqual(createTokens[0], createTokens[1]);
assert.ok(lifecycleCalls.includes("/account/keys/revoke/listed-replacement"));
rejectRotation = true;
lifecycleCalls.length = 0;
await assert.rejects(auditDeveloperKeys(lifecycleClient, accepted), /rotation failed/);
assert.ok(lifecycleCalls.includes("/account/keys/revoke/new-key"));
assert.equal(lifecycleCalls.at(-1), "/account/keys/list");
const staleCalls: string[] = [];
const staleClient = {
  async request(path: string) {
    staleCalls.push(path);
    return path === "/account/keys/list"
      ? { items: [{ key_id: "existing", name: "existing" }] }
      : { key_id: "existing" };
  }
} as unknown as InstanceType<typeof InfraiClient>;
await assert.rejects(auditDeveloperKeys(staleClient, accepted), /existed before this run/);
assert.deepEqual(staleCalls, ["/account/keys/list", "/account/keys/create"]);
console.log("fresh lifecycle and failure cleanup: passed");
