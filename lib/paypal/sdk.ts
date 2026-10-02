import "server-only";
import { Client, Environment } from "@paypal/paypal-server-sdk";
import { paypalConfig } from "./config";

let client: Client | undefined;

/**
 * One long-lived Server SDK client per process: it caches the OAuth token and
 * refreshes it when it expires.
 *
 * The SDK's default retry policy makes no retries and never retries POST. We
 * send a PayPal-Request-Id on every POST, which makes a retried POST return
 * the original result instead of repeating it, so POST is safe to retry here.
 */
export function paypalClient(): Client {
  if (client) return client;
  const cfg = paypalConfig();
  client = new Client({
    environment: cfg.mode === "live" ? Environment.Production : Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: cfg.clientId,
      oAuthClientSecret: cfg.clientSecret,
    },
    timeout: 20_000,
    httpClientOptions: {
      retryConfig: {
        maxNumberOfRetries: 2,
        retryOnTimeout: true,
        retryInterval: 1,
        maximumRetryWaitTime: 8,
        backoffFactor: 2,
        httpStatusCodesToRetry: [408, 429, 500, 502, 503, 504],
        httpMethodsToRetry: ["GET", "POST", "PATCH"],
      },
    },
  });
  return client;
}
