import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: {
    // Force Turbopack root to this app folder to avoid picking parent lockfiles/env.
    root: configDir,
  },
};

export default nextConfig;
