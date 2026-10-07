import "server-only";

/** Whether the dashboard's agent can run: it needs GEMINI_API_KEY on the server. The dashboard itself does not. */
export const insightsAiConfigured = (env: Record<string, string | undefined> = process.env) => Boolean(env.GEMINI_API_KEY?.trim());
