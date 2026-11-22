import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Ampost, MediaInput, Post, PostsCreateBody, PostValidation } from "ampost";
import type { Command, Context, Input } from "../cli.js";
import { EXIT, UsageError, type ExitCode } from "../errors.js";
import { date, fields, oneLine, pageNote, table } from "../format.js";
import {
  checkPlatform,
  fetchList,
  flag,
  id,
  integer,
  LIST_OPTIONS,
  list,
  oneOf,
  pageQuery,
  platform,
  repeated,
  string,
} from "./shared.js";

const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm"];
const POST_STATUSES = ["draft", "scheduled", "queued", "posting", "published", "partial", "failed", "discarded", "deleted"] as const;
/** While a post is `posting` (or `queued`, about to post), `--wait` keeps checking. */
const WAIT_INTERVAL_MS = 3_000;

export const post: Command = {
  name: "post",
  summary: "Create a post: publish now, schedule, queue or save a draft",
  args: "[text]",
  positionals: { min: 0, max: 1 },
  options: {
    platforms: { type: "string", short: "p", multiple: true, value: "LIST", help: "Platforms, comma-separated: bluesky,threads,x,..." },
    "platform-set": { type: "string", multiple: true, value: "ID", help: "Platform set to post from (default: your default set)" },
    "text-file": { type: "string", value: "PATH", help: "Read the text from a file, or - for stdin" },
    media: { type: "string", short: "m", multiple: true, value: "PATH|URL", help: "Image or video: a local file (uploaded) or a public https URL" },
    "alt-text": { type: "string", multiple: true, value: "TEXT", help: "Alt text for the media, in --media order" },
    link: { type: "string", value: "URL", help: "Link to attach" },
    "first-comment": { type: "string", value: "TEXT", help: "Comment posted right after the post (replies on X, Threads, Bluesky)" },
    schedule: { type: "string", short: "s", value: "TIME", help: "Publish at this time, ISO 8601: 2026-12-01T09:00:00Z" },
    queue: { type: "boolean", short: "q", help: "Schedule in the next free slot of the platform set's queue" },
    draft: { type: "boolean", help: "Save as a draft; nothing publishes" },
    "dry-run": { type: "boolean", help: "Check the post with the API's validator; create nothing" },
    wait: { type: "boolean", short: "w", help: "When publishing now: wait for the result (exit 10 if a platform failed)" },
    "wait-timeout": { type: "string", value: "SECONDS", help: "How long --wait waits (default 600)" },
    metadata: { type: "string", value: "JSON", help: "Your own JSON object, returned on the post and in webhooks" },
    "idempotency-key": { type: "string", value: "KEY", help: "Run the same command again with the same key: no duplicate post" },
  },
  help: `Without --schedule, --queue or --draft the post is published now.

Examples:
  ampost post "Hello from the terminal" -p bluesky,threads
  ampost post "Launch day" -p instagram,threads -m ./photo.jpg --alt-text "Our team" --schedule 2026-12-01T09:00:00Z
  ampost post --text-file notes.md -p threads --queue
  echo "Built by a script" | ampost post --text-file - -p bluesky --wait --json
  ampost post "Check me" -p x,bluesky --dry-run

Local --media files are uploaded first, also with --dry-run, so the check covers them.
Platform rules (lengths, media types, first comments): https://ampost.io/docs?ref=cli#platforms`,
  async run(ctx, input) {
    const body = await buildPost(ctx, input);
    const client = await ctx.client();
    if (flag(input, "dry-run")) {
      const validation = await client.posts.validate(body);
      return { data: validation, text: validationText(validation), exitCode: validation.valid ? EXIT.OK : EXIT.INVALID };
    }
    const key = string(input, "idempotency-key");
    const created = await client.posts.create(body, key ? { idempotencyKey: key } : {});
    if (!flag(input, "wait")) return { data: created, text: postText(created, "Created") };
    return waitForPost(ctx, client, created, waitTimeout(input));
  },
};

/** The `posts.create` body from the command line. Uploads local media. Exported for tests. */
export async function buildPost(ctx: Context, input: Input): Promise<PostsCreateBody> {
  const text = await readText(ctx, input);
  const platforms = list(input, "platforms").map(checkPlatform);
  if (platforms.length === 0) throw new UsageError("Choose platforms with -p, e.g. -p bluesky,threads");

  const when = [flag(input, "draft") && "--draft", string(input, "schedule") !== undefined && "--schedule", flag(input, "queue") && "--queue"].filter(Boolean);
  if (when.length > 1) throw new UsageError(`Use only one of ${when.join(", ")}`);
  if (flag(input, "wait") && when.length > 0) throw new UsageError(`--wait works only when publishing now, not with ${when[0]}`);
  if (flag(input, "wait") && flag(input, "dry-run")) throw new UsageError("--wait does not work with --dry-run");
  if (string(input, "wait-timeout") !== undefined && !flag(input, "wait")) throw new UsageError("--wait-timeout needs --wait");

  const sets = list(input, "platform-set").map((s) => id(s, "--platform-set"));
  const targets = sets.length ? sets.map((platformSetId) => ({ platformSetId, platforms })) : [{ platforms }];
  if (flag(input, "queue") && targets.length > 1) throw new UsageError("--queue takes one --platform-set: each set has its own queue");

  const sources = repeated(input, "media");
  const altTexts = repeated(input, "alt-text");
  if (altTexts.length > sources.length) throw new UsageError(`${altTexts.length} --alt-text for ${sources.length} --media`);
  if (!text && sources.length === 0) throw new UsageError("Give the post text, --text-file or --media");

  const link = string(input, "link");
  if (link !== undefined && !/^https?:\/\//i.test(link)) throw new UsageError(`--link must be an http(s) URL, got ${JSON.stringify(link)}`);
  const media = await resolveMedia(ctx, sources, altTexts);
  const firstComment = string(input, "first-comment");
  const metadata = parseMetadata(string(input, "metadata"));

  return {
    text,
    targets,
    ...(media.length && { media }),
    ...(link !== undefined && { linkUrl: link }),
    ...(firstComment !== undefined && { firstComment }),
    ...(metadata && { metadata }),
    ...scheduleFields(input),
  };
}

async function readText(ctx: Context, input: Input): Promise<string> {
  const [positional] = input.positionals;
  const file = string(input, "text-file");
  if (positional !== undefined && file !== undefined) throw new UsageError("Give the text as an argument or with --text-file, not both");
  if (positional === "-" || file === "-") {
    if (ctx.deps.io.stdinIsTTY) throw new UsageError("Reading the text from stdin, but stdin is a terminal: pipe the text in");
    return trimEnd(await ctx.deps.io.readStdin());
  }
  if (file !== undefined) {
    try {
      return trimEnd(await readFile(file, "utf8"));
    } catch (error) {
      throw new UsageError(`Cannot read --text-file ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  }
  return positional ?? "";
}

/** A file's or a pipe's final newline is not part of the post. */
function trimEnd(text: string): string {
  return text.replace(/\s+$/, "");
}

function scheduleFields(input: Input): Pick<PostsCreateBody, "publishNow" | "scheduledFor" | "useQueue"> {
  const schedule = string(input, "schedule");
  if (schedule !== undefined) {
    const at = parseTime(schedule);
    return { scheduledFor: at };
  }
  if (flag(input, "queue")) return { useQueue: true };
  if (flag(input, "draft")) return {};
  return { publishNow: true };
}

/** ISO 8601. Without an offset the time is the machine's local time, as `new Date()` reads it. */
export function parseTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.test(value.trim())) {
    throw new UsageError(`--schedule must be an ISO 8601 time like 2026-12-01T09:00:00Z, got ${JSON.stringify(value)}`);
  }
  const normalized = value.trim().replace(" ", "T");
  // A date alone would be read as UTC midnight; ask for a time instead of guessing.
  if (!normalized.includes("T")) throw new UsageError(`--schedule needs a time too, e.g. ${normalized}T09:00:00Z`);
  const at = new Date(normalized);
  if (Number.isNaN(at.getTime())) throw new UsageError(`--schedule is not a valid time: ${JSON.stringify(value)}`);
  return at.toISOString();
}

function parseMetadata(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UsageError("--metadata must be a JSON object, e.g. '{\"source\":\"cron\"}'");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--metadata must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function resolveMedia(ctx: Context, sources: string[], altTexts: string[]): Promise<MediaInput[]> {
  // Check every local file before uploading any.
  const kinds = await Promise.all(sources.map((source) => mediaKind(source)));
  const media: MediaInput[] = [];
  for (const [i, source] of sources.entries()) {
    const altText = altTexts[i] ? { altText: altTexts[i] } : {};
    if (kinds[i] === "url") {
      media.push({ url: source, type: guessType(source), ...altText });
      continue;
    }
    ctx.progress(`Uploading ${source} ...`);
    const client = await ctx.client();
    const uploaded = await client.media.upload(resolve(source));
    media.push({ ...uploaded, ...altText });
  }
  return media;
}

async function mediaKind(source: string): Promise<"url" | "file"> {
  if (/^https:\/\//i.test(source)) return "url";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new UsageError(`--media URLs must be https: ${source}`);
  try {
    const info = await stat(source);
    if (!info.isFile()) throw new UsageError(`--media ${source} is not a file`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`--media ${source}: no such file`);
  }
  return "file";
}

/** The CSV import's rule: these extensions are videos, the rest images. */
export function guessType(url: string): "image" | "video" {
  const path = url.split(/[?#]/)[0] ?? "";
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension && VIDEO_EXTENSIONS.includes(extension) ? "video" : "image";
}

function waitTimeout(input: Input): number {
  return (integer(input, "wait-timeout", 1, 86_400) ?? 600) * 1000;
}

/** Polls the post until it is no longer `posting`. Exit 0 when published, 10 when it failed anywhere. */
async function waitForPost(ctx: Context, client: Ampost, first: Post, timeoutMs: number) {
  let current = first;
  const deadline = Date.now() + timeoutMs;
  ctx.progress(`Created ${first.id}; waiting for the platforms ...`);
  while (current.status === "posting" || current.status === "queued") {
    if (Date.now() + WAIT_INTERVAL_MS > deadline) {
      ctx.progress(`Still ${current.status} after ${Math.round(timeoutMs / 1000)} s: check later with \`ampost posts get ${current.id}\``);
      return { data: current, text: postText(current, "Still publishing"), exitCode: EXIT.ERROR as ExitCode };
    }
    await ctx.deps.sleep(WAIT_INTERVAL_MS);
    current = await client.posts.get(current.id);
  }
  return { data: current, text: postText(current), exitCode: postExitCode(current) };
}

function postExitCode(p: Post): ExitCode {
  return p.status === "failed" || p.status === "partial" ? EXIT.POST_FAILED : EXIT.OK;
}

export function postText(p: Post, heading?: string): string {
  const head = fields([
    ["Post", heading ? `${p.id} (${heading.toLowerCase()})` : p.id],
    ["Status", p.status],
    ["Scheduled", p.scheduledFor ? date(p.scheduledFor) : undefined],
    ["Created", date(p.createdAt)],
    ["Text", oneLine(p.text, 72)],
    ["Media", p.media.length ? `${p.media.length} file${p.media.length === 1 ? "" : "s"}` : undefined],
    ["Link", p.linkUrl],
    ["First comment", p.firstComment ? oneLine(p.firstComment, 60) : undefined],
  ]);
  if (p.platformPosts.length === 0) return head;
  const rows = p.platformPosts.map((pp) => [
    pp.platform,
    pp.status,
    pp.publishedUrl ?? (pp.error ? `${pp.error.code}: ${oneLine(pp.error.message, 60)}` : pp.nextAttemptAt ? `next try ${date(pp.nextAttemptAt)}` : ""),
    pp.accountId,
  ]);
  const notices = p.platformPosts
    .filter((pp) => pp.notice)
    .map((pp) => `${pp.platform}: still ${pp.status}. ${pp.notice!.message} (${pp.notice!.code})`);
  return [`${head}\n\n${table(["platform", "status", "url or error", "account"], rows)}`, ...(notices.length ? ["", ...notices] : [])].join("\n");
}

function validationText(v: PostValidation): string {
  const lines = [v.valid ? "Valid: the post would be created." : "Invalid: the post would be refused."];
  for (const e of v.errors) lines.push(`  error: ${e.message} (${e.code})`);
  for (const w of v.warnings) lines.push(`  warning: ${w.message} (${w.code})`);
  if (v.targets.length) {
    const rows = v.targets.map((t) => [
      t.platform,
      t.valid ? "ok" : "invalid",
      [...t.errors.map((e) => `error: ${e.message}`), ...t.warnings.map((w) => `warning: ${w.message}`)].join("; ") || "",
    ]);
    lines.push("", table(["platform", "check", "issues"], rows));
  }
  if (v.scheduledFor) lines.push("", `Would publish at ${date(v.scheduledFor)}`);
  return lines.join("\n");
}

export const postsList: Command = {
  name: "posts list",
  summary: "List posts, newest first",
  options: {
    status: { type: "string", value: "STATUS", help: POST_STATUSES.join(", ") },
    platform: { type: "string", value: "NAME", help: "Only posts to this platform" },
    "platform-set": { type: "string", value: "ID", help: "Only posts from this platform set" },
    search: { type: "string", value: "TEXT", help: "Only posts whose text contains this" },
    ...LIST_OPTIONS,
  },
  help: `Examples:
  ampost posts list --status failed
  ampost posts list --all --json | jq -r '.data[] | select(.status == "scheduled") | .id'`,
  async run(ctx, input) {
    const setId = string(input, "platform-set");
    const query = {
      ...pageQuery(input),
      status: oneOf(input, "status", POST_STATUSES),
      platform: platform(input),
      platformSetId: setId === undefined ? undefined : id(setId, "--platform-set"),
      search: string(input, "search"),
    };
    const client = await ctx.client();
    const result = await fetchList(client.posts.list(query), input);
    if (result.data.length === 0) return { data: result, text: "No posts." };
    const rows = result.data.map((p) => [
      p.id,
      p.status,
      date(p.scheduledFor ?? p.createdAt),
      p.platformPosts.map((pp) => `${pp.platform}:${pp.status}`).join(" ") || p.platforms.join(" "),
      oneLine(p.text, 40),
    ]);
    return {
      data: result,
      text: `${table(["id", "status", "scheduled/created", "platforms", "text"], rows)}\n\n${pageNote(result.pagination, result.data.length, "post")}`,
    };
  },
};

export const postsGet: Command = {
  name: "posts get",
  summary: "Show a post and its status on each platform",
  args: "<post-id>",
  positionals: { min: 1, max: 1 },
  async run(ctx, input) {
    const client = await ctx.client();
    const p = await client.posts.get(id(input.positionals[0], "The post id"));
    return { data: p, text: postText(p), exitCode: EXIT.OK };
  },
};

export const postsRetry: Command = {
  name: "posts retry",
  summary: "Publish again to the accounts that failed",
  args: "<post-id>",
  positionals: { min: 1, max: 1 },
  options: {
    account: { type: "string", multiple: true, value: "ID", help: "Retry only this account (default: every failed one)" },
    wait: { type: "boolean", short: "w", help: "Wait for the result (exit 10 if a platform failed again)" },
    "wait-timeout": { type: "string", value: "SECONDS", help: "How long --wait waits (default 600)" },
    "idempotency-key": { type: "string", value: "KEY", help: "Repeat the command safely with the same key" },
  },
  async run(ctx, input) {
    const postId = id(input.positionals[0], "The post id");
    const accountIds = list(input, "account").map((a) => id(a, "--account"));
    if (string(input, "wait-timeout") !== undefined && !flag(input, "wait")) throw new UsageError("--wait-timeout needs --wait");
    const client = await ctx.client();
    const key = string(input, "idempotency-key");
    const retried = await client.posts.retry(postId, accountIds.length ? { accountIds } : {}, key ? { idempotencyKey: key } : {});
    if (!flag(input, "wait")) return { data: retried, text: postText(retried, "Retrying") };
    return waitForPost(ctx, client, retried, waitTimeout(input));
  },
};

export const postsDelete: Command = {
  name: "posts delete",
  summary: "Discard a post before it publishes: a draft, scheduled, queued or failed post",
  args: "<post-id>",
  positionals: { min: 1, max: 1 },
  help: "The post stays readable with status `discarded`, and its uploaded media is deleted. A partly\npublished post stops retrying; what went out stays. A published post cannot be discarded (exit 7):\ntake it down with `ampost posts unpublish`.",
  async run(ctx, input) {
    const client = await ctx.client();
    const discarded = await client.posts.delete(id(input.positionals[0], "The post id"));
    return { data: discarded, text: postText(discarded, "Discarded") };
  },
};

export const postsUnpublish: Command = {
  name: "posts unpublish",
  summary: "Delete a published post from the platforms",
  args: "<post-id>",
  positionals: { min: 1, max: 1 },
  options: {
    account: { type: "string", multiple: true, value: "ID", help: "Only this account (default: every account where it is published)" },
  },
  help: `Each account ends up \`deleted\`, or still \`published\` with a notice saying why: Instagram and
TikTok have no delete API (delete it in their app), or the platform refused (for example Telegram's
48-hour limit for bots). The post stays readable in Ampost; it becomes \`deleted\` once no account has it.
Exit 10 if any account still has it. YouTube deletes count in the channel's daily budget of edits and deletes.

Examples:
  ampost posts unpublish <post-id>
  ampost posts unpublish <post-id> --account <account-id> --json`,
  async run(ctx, input) {
    const postId = id(input.positionals[0], "The post id");
    const accountIds = list(input, "account").map((a) => id(a, "--account"));
    const client = await ctx.client();
    const p = await client.posts.unpublish(postId, accountIds.length ? { accountIds } : {});
    const targeted = p.platformPosts.filter((pp) => !accountIds.length || accountIds.includes(pp.accountId));
    const left = targeted.some((pp) => pp.status === "published");
    return { data: p, text: postText(p, "Unpublished"), exitCode: left ? EXIT.POST_FAILED : EXIT.OK };
  },
};
