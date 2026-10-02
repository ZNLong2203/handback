import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships WASM and data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // Return photos are posted to server actions; phone photos are a few MB before resizing.
    serverActions: { bodySizeLimit: "8mb" },
  },
};

export default nextConfig;
