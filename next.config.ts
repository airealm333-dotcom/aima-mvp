import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDir = path.dirname(fileURLToPath(import.meta.url));

/** Hostnames only (e.g. 192.168.1.4), comma-separated. Fixes HMR WebSocket when using LAN IP instead of localhost. */
function allowedDevOriginsFromEnv(): string[] {
  const raw = process.env.NEXT_DEV_ALLOWED_ORIGINS;
  if (!raw?.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: allowedDevOriginsFromEnv(),
  turbopack: {
    // Force Turbopack root to this app folder to avoid picking parent lockfiles/env.
    root: configDir,
  },
};

export default nextConfig;
