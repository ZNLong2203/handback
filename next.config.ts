import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM and data files that must be loaded from node_modules at runtime.
  // The Render SDK pulls in redis and eventsource for features this app does not use.
  serverExternalPackages: ["@electric-sql/pglite", "@renderinc/sdk"],
  experimental: {
    // Return photos are posted to server actions; phone photos are a few MB before resizing.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
