import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep the dev-only Next.js badge off the sidebar.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
