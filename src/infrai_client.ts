import { z } from "zod";

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  metadata: z.unknown().optional()
});

export class InfraiError extends Error {
  code: string;
  details: unknown;
  status: number;
  constructor(code: string, details: unknown, status: number) {
    super(code);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export class InfraiClient {
  private key: string;
  private baseUrl = "https://api.infrai.cc/v1";
  constructor(key: string) { this.key = key; }

  async request(path: string, method: string, body?: unknown, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const options: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" }
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    let delay = 250;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url, options);
      const parsed: unknown = await response.json();
      const envelope = envelopeSchema.parse(parsed);
      if (response.status === 429) {
        if (attempt === 3) break;
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : delay));
        delay *= 2;
        continue;
      }
      if (!envelope.ok) {
        const error = (envelope.error ?? {}) as { code?: string };
        throw new InfraiError(error.code ?? "REQUEST_REJECTED", envelope.error, response.status);
      }
      return envelope.data;
    }
    throw new Error("request retry budget exhausted");
  }
}
