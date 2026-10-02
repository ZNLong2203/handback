import "server-only";
import { paypalRest } from "./rest";
import { trustedCertUrl, verifySignature, type WebhookHeaders } from "./webhook-signature";

const certCache = new Map<string, Promise<string>>();

function fetchCert(url: string): Promise<string> {
  let pending = certCache.get(url);
  if (!pending) {
    pending = fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => {
      if (!r.ok) throw new Error(`certificate fetch failed: ${r.status}`);
      return r.text();
    });
    pending.catch(() => certCache.delete(url));
    certCache.set(url, pending);
  }
  return pending;
}

/**
 * Verifies a webhook delivery: first offline against PayPal's signing
 * certificate, then, if that is inconclusive, with PayPal's
 * verify-webhook-signature API. Anything unverified is rejected.
 */
export async function verifyWebhook(h: WebhookHeaders, webhookId: string, rawBody: Uint8Array, event: unknown): Promise<boolean> {
  if (trustedCertUrl(h.certUrl)) {
    try {
      if (verifySignature(h, webhookId, rawBody, await fetchCert(h.certUrl))) return true;
    } catch {
      // fall through to the API check
    }
  }
  try {
    const res = await paypalRest<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      body: {
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return res.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}
