import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { crc32, signedMessage, trustedCertUrl, verifySignature, type WebhookHeaders } from "./webhook-signature";

let certPem = "";
let keyPem = "";

beforeAll(() => {
  // A throwaway self-signed certificate stands in for PayPal's signing certificate.
  const dir = mkdtempSync(path.join(tmpdir(), "hb-webhook-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/k.pem`, "-out", `${dir}/c.pem`, "-days", "2", "-subj", "/CN=webhook-test"], {
    stdio: "ignore",
  });
  certPem = readFileSync(`${dir}/c.pem`, "utf8");
  keyPem = readFileSync(`${dir}/k.pem`, "utf8");
});

const body = Buffer.from(JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } }));

function signed(webhookId: string, raw: Buffer): WebhookHeaders {
  const h: WebhookHeaders = {
    transmissionId: "a1b2c3",
    transmissionTime: "2026-10-02T10:00:00Z",
    transmissionSig: "",
    certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    authAlgo: "SHA256withRSA",
  };
  const signer = createSign("RSA-SHA256");
  signer.update(signedMessage(h, webhookId, raw));
  return { ...h, transmissionSig: signer.sign(keyPem, "base64") };
}

describe("webhook signature", () => {
  it("computes CRC-32 like PayPal (IEEE check value)", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("accepts a delivery signed for this webhook id", () => {
    const h = signed("WH-ID-1", body);
    expect(verifySignature(h, "WH-ID-1", body, certPem)).toBe(true);
  });

  it("rejects a changed body, another webhook id, or another algorithm", () => {
    const h = signed("WH-ID-1", body);
    expect(verifySignature(h, "WH-ID-1", Buffer.from(body.toString().replace("CAP-1", "CAP-2")), certPem)).toBe(false);
    expect(verifySignature(h, "WH-ID-2", body, certPem)).toBe(false);
    expect(verifySignature({ ...h, authAlgo: "SHA1withRSA" }, "WH-ID-1", body, certPem)).toBe(false);
  });

  it("rejects an expired certificate", () => {
    const h = signed("WH-ID-1", body);
    expect(verifySignature(h, "WH-ID-1", body, certPem, new Date(Date.now() + 10 * 86_400_000))).toBe(false);
  });

  it("only trusts certificates from PayPal's hosts over HTTPS", () => {
    expect(trustedCertUrl("https://api.paypal.com/v1/notifications/certs/X")).toBe(true);
    expect(trustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/X")).toBe(true);
    expect(trustedCertUrl("http://api.paypal.com/v1/notifications/certs/X")).toBe(false);
    expect(trustedCertUrl("https://paypal.com.evil.example/cert")).toBe(false);
  });
});
