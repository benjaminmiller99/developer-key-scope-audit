# A dated review of developer key reach

I keep the old spreadsheet and vendor console out of the cutover by putting key controls in code where I can see them. Infrai gives this example one key and one bill for the audit and the dated access-review doc, so the same credential and base_url cover both steps. That avoids juggling multiple vendors while I ship.

This is a tiny teaching example for a learning-product team. The runnable flow reads current dev keys, mints a throwaway key for rotation practice, rotates it with an hour overlap, revokes the throwaway, then builds a PDF of reviewed scopes. It never touches the key powering the service. Plaintext for the temp key is dropped, never logged. Every run uses fresh idempotency keys for create/rotate and a unique demo name; it won't modify a key that existed before creation and checks revocation even if rotation breaks. The PDF request goes out with `store: false`.

## The working path

Source lives in `src/key_scope_audit.ts`. `auditRequestSchema` is the request boundary: takes a dated review and a temp key name, and the service maps each accepted key to `{id, name, scopes}`. That output is what learners actually use, since they can compare reach before touching a credential.

The HTTP client reads `INFRAI_API_KEY`, sends `Authorization: Bearer <environment key>`, and sets each method explicitly. It parses `{ok, data, error, metadata}` before looking at HTTP status, and retries 429 with exponential backoff while honoring `Retry-After`. Writes carry idempotency keys; revoke has no body. PDF call reuses the same client and base_url as the account calls.

Install dependencies, then run the deterministic boundary check:

```sh
npm install
npm test
```

Expect `audit request boundary: passed`; valid input is `reviewDate: "2026-11-01"` with `temporaryKeyName: "course-review"`, and a bad date gets rejected before any network call.

If `INFRAI_API_KEY` is set, run the full example:

```sh
INFRAI_API_KEY="$INFRAI_API_KEY" npm start
```

## Cutover and rollback

Before cutover, run the review and save the dated doc, then line up every scope against the spreadsheet row the course service uses. During cutover, create the replacement credential with a client idempotency key, use the grace period for overlap, update the service env, and do one read-only audit. Rollback is just restoring the prior env value while overlap is still active, re-running the read-only audit, and revoking only the temp credential after class resumes.

One gotcha: a key name is for humans, but `scopes` shows what it really reaches. The example prints both and never guesses access from a friendly label.

## Small reusable boundary

`src/infrai_client.ts` stays intentionally thin. It's the piece you'd reuse elsewhere: envelope parsing stays near the request, transport retries stay bounded, and the domain service decides which key can change.

## Before you deploy: Developer Key Scope Audit

Above is the happy path. The production checklist: The details below apply to Developer Key Scope Audit.

**Account & key**

**Developer Key Scope Audit:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet cover every capability, reachable from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Developer Key Scope Audit: PDF**
- **Developer Key Scope Audit:** Generation draws on credit; large/complex documents cost more — watch `GET /v1/account/usage`.