import { createVerify, X509Certificate } from "node:crypto";

export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

export function webhookHeaders(h: Headers): WebhookHeaders | null {
  const get = (k: string) => h.get(k) ?? "";
  const out = {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
  return Object.values(out).every(Boolean) ? out : null;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as PayPal uses for the webhook body in the signed message. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The exact string PayPal signs: transmission id | time | webhook id | CRC-32 of the raw body. */
export function signedMessage(h: WebhookHeaders, webhookId: string, rawBody: Uint8Array): string {
  return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(rawBody)}`;
}

/** Only certificates served from PayPal's own hosts over HTTPS are trusted. */
export function trustedCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "api.paypal.com" || u.hostname === "api.sandbox.paypal.com" || u.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

/**
 * Checks a webhook delivery offline: the signature over the signed message
 * must verify against the certificate PayPal points to, and that
 * certificate must be currently valid.
 */
export function verifySignature(h: WebhookHeaders, webhookId: string, rawBody: Uint8Array, certPem: string, now = new Date()): boolean {
  if (!/^SHA256withRSA$/i.test(h.authAlgo)) return false;
  const cert = new X509Certificate(certPem);
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return false;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signedMessage(h, webhookId, rawBody));
  return verifier.verify(cert.publicKey, Buffer.from(h.transmissionSig, "base64"));
}
