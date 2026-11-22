import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { run, type Deps } from "../src/cli.js";

export interface Call {
  method: string;
  url: URL;
  path: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * A fake API: `routes` maps `METHOD /path` (exact) to a handler or a list of handlers used in turn.
 * Any other request fails the test.
 */
export function fakeApi(routes: Record<string, Handler | Handler[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const call: Call = { method: init.method ?? "GET", url, path: url.pathname, headers: new Headers(init.headers), body };
    calls.push(call);
    const key = `${call.method} ${url.origin === "https://api.ampost.io" ? url.pathname : url.href.split("?")[0]}`;
    const entry = queues.get(key);
    if (!entry) throw new Error(`Unexpected request ${key}`);
    const handler = Array.isArray(entry) ? entry.length > 1 ? entry.shift()! : entry[0] : entry;
    if (!handler) throw new Error(`No reply left for ${key}`);
    return handler(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export const reply = (body: unknown, status = 200) => () => json(status, body);

export function apiError(status: number, code: string, message = "Something went wrong", details?: Record<string, unknown>) {
  // Retry-After: 0 keeps the SDK's retries of 429 and 5xx instant.
  return () => json(status, { error: { code, message, ...(details && { details }) } }, { "retry-after": "0", "x-request-id": "req_123" });
}

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, empty config directory. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ampost-cli-test-"));
  dirs.push(dir);
  return dir;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  stdin?: string;
  tty?: boolean;
  secret?: string;
}

export const KEY = "amp_live_testkey_0123456789abcdef";

/** Runs the CLI in-process. By default with AMPOST_API_KEY set and an empty config directory. */
export async function cli(argv: string[], options: RunOptions = {}) {
  let stdout = "";
  let stderr = "";
  const slept: number[] = [];
  const deps: Deps = {
    env: { AMPOST_API_KEY: KEY, AMPOST_CONFIG_DIR: tempDir(), ...options.env },
    io: {
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
      stdinIsTTY: options.tty ?? options.stdin === undefined,
      readStdin: async () => options.stdin ?? "",
      promptSecret: async () => options.secret ?? "",
    },
    ...(options.fetch && { fetch: options.fetch }),
    sleep: async (ms) => void slept.push(ms),
  };
  const code = await run(argv, deps);
  return {
    code,
    stdout,
    stderr,
    slept,
    /** stdout parsed as JSON (for --json runs). */
    get json(): any {
      return JSON.parse(stdout);
    },
  };
}

export const IDS = {
  post: "11111111-1111-4111-8111-111111111111",
  account: "22222222-2222-4222-8222-222222222222",
  set: "33333333-3333-4333-8333-333333333333",
  webhook: "44444444-4444-4444-8444-444444444444",
  upload: "55555555-5555-4555-8555-555555555555",
};

export function page<T>(data: T[], pagination: Partial<{ limit: number; offset: number; total: number; hasMore: boolean }> = {}) {
  return { data, pagination: { limit: 20, offset: 0, total: data.length, hasMore: false, ...pagination } };
}

export function platformPost(overrides: Record<string, unknown> = {}) {
  return {
    platform: "bluesky",
    accountId: IDS.account,
    platformSetId: IDS.set,
    status: "published",
    platformPostId: "at://did:plc:x/app.bsky.feed.post/1",
    publishedUrl: "https://bsky.app/profile/x/post/1",
    text: null,
    error: null,
    notice: null,
    warnings: [],
    attempts: 1,
    nextAttemptAt: null,
    firstComment: null,
    mediaTransforms: null,
    thread: null,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:01.000Z",
    ...overrides,
  };
}

export function postFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.post,
    status: "published",
    targets: [{ platformSetId: IDS.set, platforms: ["bluesky"] }],
    platforms: ["bluesky"],
    text: "Hello",
    firstComment: null,
    linkUrl: null,
    media: [],
    mediaFit: "auto",
    thread: [],
    options: {},
    scheduledFor: null,
    queuePlatformSetId: null,
    source: "api",
    metadata: null,
    platformPosts: [platformPost()],
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:01.000Z",
    ...overrides,
  };
}

export function accountFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.account,
    platform: "bluesky",
    platformSetId: IDS.set,
    platformAccountId: "did:plc:x",
    username: "ampost.bsky.social",
    avatarUrl: null,
    status: "active",
    scopes: [],
    tokenExpiresAt: null,
    tokenHealth: "healthy",
    health: { status: "healthy", issues: [] },
    platformMetadata: {},
    analytics: {},
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

export function webhookFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.webhook,
    url: "https://example.com/hooks/ampost",
    description: null,
    events: ["post.published"],
    secretPreview: "whsec_ab…",
    enabled: true,
    disabledReason: null,
    disabledAt: null,
    consecutiveFailures: 0,
    lastDeliveryAt: null,
    lastSuccessAt: null,
    createdAt: "2026-11-22T10:00:00.000Z",
    updatedAt: "2026-11-22T10:00:00.000Z",
    ...overrides,
  };
}
