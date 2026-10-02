import type { NextConfig } from "next";

/**
 * A GitHub Codespace serves port N at https://<codespace>-N.<domain> and hands
 * each request to localhost:N, so the browser's Origin and the host Next sees
 * (x-forwarded-host or Host) can differ. Next then rejects every Server Action
 * as cross-origin, and next dev refuses its dev-only endpoints, such as the
 * hot-reload socket, to hosts other than localhost. Inside a Codespace both
 * hosts are allowed. Anywhere else the lists stay empty, which Next treats the
 * same as unset, so a deployed copy keeps the same-origin check.
 */
function codespaceHosts(): { forwarded: string; local: string } | undefined {
  const { CODESPACES, CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN, PORT } = process.env;
  if (CODESPACES !== "true" || !CODESPACE_NAME) return undefined;
  // next dev and next start set PORT to the port they bound before reading this file.
  const port = PORT || "3000";
  return {
    forwarded: `${CODESPACE_NAME}-${port}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev"}`,
    local: `localhost:${port}`,
  };
}

const codespace = codespaceHosts();

const nextConfig: NextConfig = {
  // PGlite ships WASM and data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  allowedDevOrigins: codespace ? [codespace.forwarded] : [],
  experimental: {
    serverActions: {
      // Return photos are posted to server actions; phone photos are a few MB before resizing.
      bodySizeLimit: "8mb",
      allowedOrigins: codespace ? [codespace.forwarded, codespace.local] : [],
    },
  },
};

export default nextConfig;
