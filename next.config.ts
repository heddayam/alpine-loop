import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.ALPINE_NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
};

export default nextConfig;
