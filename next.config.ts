import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root (silences the lockfile-detection warning).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
