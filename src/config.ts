import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/** What `ampost login` stores. */
export interface Config {
  apiKey?: string;
  /** Set when the key was saved for another API host (AMPOST_BASE_URL at login). */
  baseUrl?: string;
}

/**
 * The OS config directory: `AMPOST_CONFIG_DIR` if set, else `%APPDATA%\ampost` on Windows,
 * `~/Library/Application Support/ampost` on macOS, `$XDG_CONFIG_HOME/ampost` or `~/.config/ampost` elsewhere.
 */
export function configDir(env: Env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.AMPOST_CONFIG_DIR) return env.AMPOST_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "ampost");
  if (platform === "darwin") return join(home, "Library", "Application Support", "ampost");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "ampost");
}

export function configPath(env: Env): string {
  return join(configDir(env), "config.json");
}

export async function readConfig(env: Env): Promise<Config> {
  let text: string;
  try {
    text = await readFile(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    const { apiKey, baseUrl } = parsed as Record<string, unknown>;
    return {
      ...(typeof apiKey === "string" && apiKey && { apiKey }),
      ...(typeof baseUrl === "string" && baseUrl && { baseUrl }),
    };
  } catch {
    throw new Error(`${configPath(env)} is not valid JSON: fix or delete it, or run \`ampost logout\``);
  }
}

/** Writes the config readable by the user only (0600 in a 0700 directory; Windows ignores the modes). */
export async function writeConfig(env: Env, config: Config): Promise<string> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFile keeps the mode of an existing file.
  await chmod(path, 0o600);
  return path;
}

/** Deletes the stored key. Returns false when there was none. */
export async function deleteConfig(env: Env): Promise<boolean> {
  const config = await readConfig(env);
  if (!config.apiKey) return false;
  await rm(configPath(env), { force: true });
  return true;
}

export interface Credentials {
  apiKey: string;
  baseUrl: string | undefined;
  source: "env" | "config";
}

/** AMPOST_API_KEY wins over the stored key, so a script or an agent can override a login. */
export async function resolveCredentials(env: Env): Promise<Credentials | undefined> {
  if (env.AMPOST_API_KEY) return { apiKey: env.AMPOST_API_KEY, baseUrl: env.AMPOST_BASE_URL || undefined, source: "env" };
  const config = await readConfig(env);
  if (!config.apiKey) return undefined;
  return { apiKey: config.apiKey, baseUrl: env.AMPOST_BASE_URL || config.baseUrl, source: "config" };
}

/** `amp_live_abc…wxyz`: enough to tell keys apart, never the whole key. */
export function maskKey(key: string): string {
  if (key.length < 24) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}
