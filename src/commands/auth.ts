import { Ampost, AuthenticationError, PermissionDeniedError } from "ampost";
import type { Command } from "../cli.js";
import { configPath, deleteConfig, maskKey, readConfig, resolveCredentials, writeConfig } from "../config.js";
import { CliError, EXIT, UsageError } from "../errors.js";
import { fields } from "../format.js";
import { flag } from "./shared.js";

export const login: Command = {
  name: "login",
  summary: "Save an API key in your config directory",
  options: {
    "no-verify": { type: "boolean", help: "Save the key without checking it against the API" },
  },
  help: `Reads the key from a hidden prompt, or from stdin when stdin is not a terminal:

  ampost login
  printf '%s' "$AMPOST_API_KEY" | ampost login

Create a key at https://ampost.io/app/settings/api-keys?ref=cli. The key is stored, readable by
you only, in config.json in the ampost config directory (~/.config/ampost on Linux, ~/Library/Application
Support/ampost on macOS, %APPDATA%\\ampost on Windows; AMPOST_CONFIG_DIR overrides it).
AMPOST_API_KEY, when set, is used instead of the stored key.`,
  async run(ctx, input) {
    const { io, env } = ctx.deps;
    const raw = io.stdinIsTTY ? await io.promptSecret("Ampost API key: ") : await io.readStdin();
    const apiKey = raw.trim();
    if (!apiKey) throw new UsageError("No API key given");
    if (/\s/.test(apiKey)) throw new UsageError("The API key contains spaces: paste only the key");

    const baseUrl = env.AMPOST_BASE_URL || undefined;
    let verified = false;
    let warning: string | undefined;
    if (!flag(input, "no-verify")) {
      const client = new Ampost({
        apiKey,
        ...(baseUrl && { baseUrl }),
        ...(ctx.deps.fetch && { fetch: ctx.deps.fetch }),
      });
      try {
        // Any key may call it unless its scopes leave out posts:read; a 403 still proves the key is real.
        await client.platforms.list({ limit: 1 });
        verified = true;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          throw new CliError("The API refused this key: it is wrong or revoked. Nothing was saved.", EXIT.AUTH, error.code);
        }
        if (!(error instanceof PermissionDeniedError)) throw error;
        verified = true;
        warning = "The key is valid but lacks the posts:read scope; some commands will fail with exit code 4.";
      }
    }

    const path = await writeConfig(env, { apiKey, ...(baseUrl && { baseUrl }) });
    const lines = [`Saved ${maskKey(apiKey)} to ${path}`];
    if (warning) lines.push(warning);
    if (env.AMPOST_API_KEY && env.AMPOST_API_KEY !== apiKey) {
      lines.push("Note: AMPOST_API_KEY is set in this shell and is used instead of the saved key.");
    }
    return { data: { saved: true, verified, path, key: maskKey(apiKey), ...(baseUrl && { baseUrl }) }, text: lines.join("\n") };
  },
};

export const logout: Command = {
  name: "logout",
  summary: "Delete the saved API key",
  async run(ctx) {
    const { env } = ctx.deps;
    const removed = await deleteConfig(env);
    const lines = [removed ? `Deleted the key saved in ${configPath(env)}` : "No key was saved."];
    if (env.AMPOST_API_KEY) lines.push("AMPOST_API_KEY is still set in this shell.");
    return { data: { removed, path: configPath(env) }, text: lines.join("\n") };
  },
};

export const status: Command = {
  name: "status",
  summary: "Show which API key is used, without calling the API",
  async run(ctx) {
    const { env } = ctx.deps;
    const credentials = await resolveCredentials(env);
    const saved = await readConfig(env);
    const data = {
      authenticated: Boolean(credentials),
      source: credentials?.source ?? null,
      key: credentials ? maskKey(credentials.apiKey) : null,
      baseUrl: credentials?.baseUrl ?? "https://api.ampost.io",
      configPath: configPath(env),
      savedKey: saved.apiKey ? maskKey(saved.apiKey) : null,
    };
    if (!credentials) {
      return {
        data,
        text: "Not logged in. Run `ampost login`, or set AMPOST_API_KEY.",
        exitCode: EXIT.AUTH,
      };
    }
    return {
      data,
      text: fields([
        ["Key", data.key],
        ["From", credentials.source === "env" ? "AMPOST_API_KEY" : data.configPath],
        ["API", data.baseUrl],
      ]),
    };
  },
};
