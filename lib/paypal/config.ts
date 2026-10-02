import "server-only";

export type PayPalMode = "sandbox" | "live" | "demo";

export type PayPalConfig = {
  mode: PayPalMode;
  clientId: string;
  clientSecret: string;
  webhookId: string | undefined;
  apiBase: string;
};

/**
 * DEMO_MODE=true, or missing credentials, runs the in-memory gateway so the
 * app works for anyone who clones it without a PayPal account.
 */
export function paypalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  const demo = env.DEMO_MODE === "true" || !clientId || !clientSecret;
  const live = env.PAYPAL_ENVIRONMENT === "live";
  return {
    mode: demo ? "demo" : live ? "live" : "sandbox",
    clientId,
    clientSecret,
    webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
    apiBase: live ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com",
  };
}
