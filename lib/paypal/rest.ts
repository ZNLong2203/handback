import "server-only";
import { randomUUID } from "node:crypto";
import { paypalConfig } from "./config";
import { paypalErrorFromBody, PayPalError } from "./errors";
import { encodeMultipart, type MultipartPart } from "./multipart";

/**
 * A small REST client for the PayPal APIs the Server SDK does not cover
 * (Webhooks, Disputes). Tokens are cached until a minute before expiry and
 * refreshed on a 401; 429 and 5xx are retried with backoff, honouring
 * Retry-After; every POST carries a PayPal-Request-Id, the same one on every
 * retry, so a retried POST cannot act twice.
 */
let token: { value: string; expiresAt: number } | undefined;

async function accessToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  const cfg = paypalConfig();
  const res = await fetch(`${cfg.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}` },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw paypalErrorFromBody(res.status, body, res.headers.get("paypal-debug-id"));
  token = { value: body.access_token, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
  return token.value;
}

type Options = {
  requestId?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as multipart/form-data (Disputes evidence uploads). */
  multipart?: MultipartPart[];
  attempts?: number;
};

export type PayPalResponse<T> = { data: T; status: number; debugId: string | null };

/** Like paypalRest, but also returns the HTTP status and PayPal-Debug-Id of a success. */
export async function paypalRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: Options = {}): Promise<PayPalResponse<T>> {
  if (opts.body !== undefined && opts.multipart) throw new TypeError("send either a JSON body or multipart parts, not both");
  const cfg = paypalConfig();
  const attempts = opts.attempts ?? 3;
  // Decided once, before the first attempt: retries must reuse the same id and bytes.
  const requestId = method === "POST" ? (opts.requestId ?? randomUUID()) : undefined;
  const multipart = opts.multipart ? encodeMultipart(opts.multipart) : undefined;
  const body = multipart ? multipart.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, Prefer: "return=representation" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    if (multipart) headers["Content-Type"] = multipart.contentType;
    else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase}${path}`, { method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (attempt >= attempts) throw new PayPalError(0, "NETWORK_ERROR", undefined, undefined, err instanceof Error ? err.message : String(err));
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await accessToken(true);
      attempt--;
      continue;
    }
    const debugId = res.headers.get("paypal-debug-id");
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // A proxy or outage page instead of PayPal JSON: keep the status, drop the body.
      if (res.ok) throw new PayPalError(res.status, "INVALID_RESPONSE", undefined, debugId ?? undefined, "PayPal answered with something that is not JSON");
      json = {};
    }
    if (res.ok) return { data: json as T, status: res.status, debugId };
    const err = paypalErrorFromBody(res.status, json, debugId);
    if (!err.retryable || attempt >= attempts) throw err;
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt));
  }
}

export async function paypalRest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: Options = {}): Promise<T> {
  return (await paypalRequest<T>(method, path, opts)).data;
}
