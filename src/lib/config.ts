import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type RequiredEnv = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

function isProbablyValidServiceRoleKey(value: string | undefined) {
  // JWT-based keys should be comfortably longer than a few chars.
  return typeof value === "string" && value.length >= 50;
}

function isProbablyValidSupabaseUrl(value: string | undefined) {
  if (typeof value !== "string" || value.length < 20) return false;
  if (!value.startsWith("https://")) return false;
  if (!value.includes(".supabase.co")) return false;
  if (value.includes("xxxx")) return false;
  if (value.includes("example.supabase.co")) return false;
  return true;
}

function parseEnvFile(filePath: string) {
  try {
    // Server-side only: avoids relying on dotenv override behavior.
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    const result: Record<string, string> = {};
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

function getRequiredEnv(): RequiredEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    throw new Error(
      "Missing required Supabase environment variables. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  };
}

function getRequiredEnvOrNull(): RequiredEnv | null {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If an invalid/truncated value was injected into process.env,
  // fall back to reading the local `.env.local` file.
  if (
    !isProbablyValidSupabaseUrl(url) ||
    !isProbablyValidServiceRoleKey(serviceRole)
  ) {
    const candidateEnvPaths = [
      join(process.cwd(), ".env.local"),
      join(process.cwd(), "aima-mvp", ".env.local"),
    ];
    let envFromFile: Record<string, string> | null = null;
    for (const envPath of candidateEnvPaths) {
      envFromFile = parseEnvFile(envPath);
      if (envFromFile) break;
    }

    if (!isProbablyValidSupabaseUrl(url)) {
      url = envFromFile?.NEXT_PUBLIC_SUPABASE_URL;
    }
    if (!isProbablyValidServiceRoleKey(serviceRole)) {
      serviceRole = envFromFile?.SUPABASE_SERVICE_ROLE_KEY;
    }
  }

  if (!url || !serviceRole || !isProbablyValidServiceRoleKey(serviceRole)) {
    return null;
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  };
}

export function getSupabaseRuntimeConfigOrNull() {
  const required = getRequiredEnvOrNull();
  if (!required) return null;

  return {
    url: required.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: process.env.SUPABASE_MAIL_BUCKET ?? "mail-intake",
  };
}

export function getSupabaseRuntimeConfig() {
  const required = getRequiredEnv();

  return {
    url: required.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: process.env.SUPABASE_MAIL_BUCKET ?? "mail-intake",
  };
}
