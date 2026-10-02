import "server-only";
import { randomUUID } from "node:crypto";
import { paypalConfig } from "./config";
import { paypalErrorFromBody, PayPalError } from "./errors";

/**
 * A small REST client for the PayPal APIs the Server SDK does not cover
 * (Webhooks, Disputes). Tokens are cached until a minute before expiry and
 * refreshed on a 401; 429 and 5xx are retried with backoff, honouring
 * Retry-After; every POST carries a PayPal-Request-Id.
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

type Options = { requestId?: string; body?: unknown; form?: FormData; attempts?: number };

export async function paypalRest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, opts: Options = {}): Promise<T> {
  const cfg = paypalConfig();
  const attempts = opts.attempts ?? 3;
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await accessToken()}`, Prefer: "return=representation" };
    if (method === "POST") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase}${path}`, {
        method,
        headers,
        body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal: AbortSignal.timeout(20_000),
      });
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
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (res.ok) return json as T;
    const err = paypalErrorFromBody(res.status, json, res.headers.get("paypal-debug-id"));
    if (!err.retryable || attempt >= attempts) throw err;
    const retryAfter = Number(res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt));
  }
}
