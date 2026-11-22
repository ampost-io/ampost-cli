import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configDir, maskKey } from "../src/config.js";
import { EXIT } from "../src/errors.js";
import { accountFixture, apiError, cli, fakeApi, IDS, KEY, page, reply, tempDir, webhookFixture } from "./helpers.js";

const NO_ENV_KEY = { AMPOST_API_KEY: undefined };

describe("login, logout, status", () => {
  it("checks the key, then saves it readable by the user only", async () => {
    const dir = tempDir();
    const api = fakeApi({ "GET /api/platforms": reply(page([])) });
    const r = await cli(["login"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir }, fetch: api.fetch, secret: `  ${KEY}\n` });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(api.calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(api.calls[0]!.url.searchParams.get("limit"), "1");
    const path = join(dir, "config.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { apiKey: KEY });
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(r.stdout, new RegExp(`Saved ${maskKey(KEY)}`));
    assert.ok(!r.stdout.includes(KEY), "never prints the whole key");

    // The saved key is used when AMPOST_API_KEY is not set...
    const accounts = fakeApi({ "GET /api/accounts": reply(page([])) });
    await cli(["accounts", "list"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir }, fetch: accounts.fetch });
    assert.equal(accounts.calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    // ...and AMPOST_API_KEY wins over it.
    await cli(["accounts", "list"], { env: { AMPOST_API_KEY: "amp_live_other", AMPOST_CONFIG_DIR: dir }, fetch: accounts.fetch });
    assert.equal(accounts.calls[1]!.headers.get("authorization"), "Bearer amp_live_other");

    const status = await cli(["status", "--json"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir } });
    assert.equal(status.code, EXIT.OK);
    assert.equal(status.json.source, "config");
    assert.equal(status.json.key, maskKey(KEY));

    const out = await cli(["logout"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir } });
    assert.equal(out.code, EXIT.OK);
    assert.match(out.stdout, /Deleted/);
    const after = await cli(["status"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir } });
    assert.equal(after.code, EXIT.AUTH);
    assert.match(after.stdout, /Not logged in/);
  });

  it("reads the key from stdin when it is not a terminal", async () => {
    const dir = tempDir();
    const r = await cli(["login", "--no-verify", "--json"], { env: { AMPOST_CONFIG_DIR: dir }, stdin: "amp_live_piped_key_000000000\n" });
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(r.json, { saved: true, verified: false, path: join(dir, "config.json"), key: maskKey("amp_live_piped_key_000000000") });
  });

  it("saves nothing when the API refuses the key", async () => {
    const dir = tempDir();
    const api = fakeApi({ "GET /api/platforms": apiError(401, "UNAUTHORIZED", "Invalid API key") });
    const r = await cli(["login"], { env: { AMPOST_CONFIG_DIR: dir }, fetch: api.fetch, secret: "amp_live_wrong" });
    assert.equal(r.code, EXIT.AUTH);
    assert.match(r.stderr, /Nothing was saved/);
    const status = await cli(["status", "--json"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir } });
    assert.equal(status.json.savedKey, null);
  });

  it("saves a key without posts:read, with a warning", async () => {
    const api = fakeApi({ "GET /api/platforms": apiError(403, "INSUFFICIENT_SCOPE", "Missing scope") });
    const r = await cli(["login"], { fetch: api.fetch, secret: KEY });
    assert.equal(r.code, EXIT.OK);
    assert.match(r.stdout, /lacks the posts:read scope/);
  });

  it("refuses an empty key", async () => {
    const r = await cli(["login"], { secret: "" });
    assert.equal(r.code, EXIT.USAGE);
  });

  it("finds the OS config directory", () => {
    assert.equal(configDir({ AMPOST_CONFIG_DIR: "/x" }, "linux", "/home/a"), "/x");
    assert.equal(configDir({}, "linux", "/home/a"), join("/home/a", ".config", "ampost"));
    assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/a"), join("/xdg", "ampost"));
    assert.equal(configDir({}, "darwin", "/Users/a"), join("/Users/a", "Library", "Application Support", "ampost"));
    assert.equal(configDir({ APPDATA: "C:\\AppData" }, "win32", "C:\\Users\\a"), join("C:\\AppData", "ampost"));
  });

  it("reports a broken config file instead of ignoring it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), "{nope");
    const r = await cli(["accounts", "list"], { env: { ...NO_ENV_KEY, AMPOST_CONFIG_DIR: dir } });
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.stderr, /not valid JSON/);
  });
});

describe("accounts and platform sets", () => {
  it("lists accounts with filters", async () => {
    const api = fakeApi({ "GET /api/accounts": reply(page([accountFixture(), accountFixture({ platform: "threads", username: "ampost" })])) });
    const r = await cli(["accounts", "list", "--platform", "threads", "--status", "all"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(Object.fromEntries(api.calls[0]!.url.searchParams), { platform: "threads", status: "all" });
    assert.match(r.stdout, /^ID +PLATFORM +USERNAME/);
    assert.match(r.stdout, /bluesky +ampost\.bsky\.social/);
    assert.match(r.stdout, /\n2 accounts\n$/);
  });

  it("prints an empty list helpfully", async () => {
    const api = fakeApi({ "GET /api/accounts": reply(page([])) });
    const r = await cli(["accounts", "list"], { fetch: api.fetch });
    assert.match(r.stdout, /No accounts/);
  });

  it("shows an account's health, and disconnects one", async () => {
    const health = {
      canPost: false,
      needsReconnect: true,
      issues: [{ code: "TOKEN_EXPIRED", message: "The token expired.", severity: "error" }],
    };
    const api = fakeApi({
      [`GET /api/accounts/${IDS.account}`]: reply(accountFixture({ health })),
      [`DELETE /api/accounts/${IDS.account}`]: reply(
        accountFixture({ status: "revoked", providerRevoked: false, providerAccessSettings: "https://www.threads.net/settings", health }),
      ),
    });
    const r = await cli(["accounts", "get", IDS.account], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stdout, /Can post: +no/);
    assert.match(r.stdout, /error: The token expired\. \(TOKEN_EXPIRED\)/);
    const d = await cli(["accounts", "disconnect", IDS.account], { fetch: api.fetch });
    assert.equal(d.code, EXIT.OK, d.stderr);
    assert.equal(api.calls[1]!.method, "DELETE");
    assert.match(d.stdout, /\(disconnected\)/);
    assert.match(d.stdout, /Remove Ampost at https:\/\/www\.threads\.net\/settings/);
    assert.equal((await cli(["accounts", "disconnect", "nope"], { fetch: api.fetch })).code, EXIT.USAGE);
  });
});

describe("import-csv", () => {
  const result = (dryRun: boolean, errors: number) => ({
    dryRun,
    summary: { rows: 2, valid: 2 - errors, created: dryRun ? 0 : 2 - errors, errors },
    warnings: [{ column: "notes", message: "Unknown column, skipped" }],
    rows: [
      { row: 2, status: dryRun ? "valid" : "created", postId: dryRun ? null : IDS.post, scheduledFor: "2026-12-01T09:00:00.000Z", errors: [] },
      errors
        ? { row: 3, status: "error", postId: null, scheduledFor: null, errors: [{ code: "UNKNOWN_PLATFORM", message: "Unknown platform myspace", column: "platforms" }] }
        : { row: 3, status: dryRun ? "valid" : "created", postId: dryRun ? null : IDS.post, scheduledFor: null, errors: [] },
    ],
  });

  it("sends the file and exits 6 when a row has errors", async () => {
    const file = join(tempDir(), "week.csv");
    writeFileSync(file, "text,platforms\nHi,bluesky\nYo,myspace\n");
    const api = fakeApi({ "POST /api/posts/bulk": reply(result(true, 1)) });
    const r = await cli(["import-csv", file, "--dry-run"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.INVALID);
    assert.deepEqual(api.calls[0]!.body, { csv: "text,platforms\nHi,bluesky\nYo,myspace\n", dryRun: true });
    assert.match(r.stdout, /^Dry run: 2 rows, 1 valid, 1 with errors/);
    assert.match(r.stdout, /warning: notes: Unknown column/);
    assert.match(r.stdout, /3 +platforms +Unknown platform myspace \(UNKNOWN_PLATFORM\)/);
  });

  it("imports from stdin with an idempotency key, exit 0", async () => {
    const api = fakeApi({ "POST /api/posts/bulk": reply(result(false, 0)) });
    const r = await cli(["import-csv", "-", "--idempotency-key", "week-48", "--json"], { fetch: api.fetch, stdin: "text,platforms\nHi,bluesky\n" });
    assert.equal(r.code, EXIT.OK);
    assert.equal(api.calls[0]!.headers.get("idempotency-key"), "week-48");
    assert.deepEqual(api.calls[0]!.body, { csv: "text,platforms\nHi,bluesky\n", dryRun: false });
    assert.equal(r.json.summary.created, 2);
  });

  it("refuses a missing or empty file", async () => {
    const empty = join(tempDir(), "empty.csv");
    writeFileSync(empty, "\n");
    for (const argv of [["import-csv", "nope.csv"], ["import-csv", empty], ["import-csv", "-"]]) {
      const r = await cli(argv, { tty: true });
      assert.equal(r.code, EXIT.USAGE, argv.join(" "));
    }
  });
});

describe("analytics", () => {
  const metrics = { views: 1200, reach: null, likes: 30, comments: 4, shares: null, saves: null, quotes: null };

  it("shows the overview for a date range", async () => {
    const api = fakeApi({
      "GET /api/analytics/overview": reply({
        from: "2026-11-01",
        to: "2026-11-30",
        totals: { posts: 12, followers: 5400, followersChange: 120, metrics },
        accounts: [
          { accountId: IDS.account, platform: "bluesky", platformSetId: IDS.set, username: "ampost.bsky.social", posts: 12, followers: 5400, followersChange: 120, metrics, syncState: "up_to_date", syncedAt: null, nextSyncAt: null },
        ],
        unavailableAccounts: [{ accountId: IDS.account, platform: "discord", platformSetId: null, reason: "not_available_on_platform" }],
      }),
    });
    const r = await cli(["analytics", "--from", "2026-11-01", "--to", "2026-11-30", "--platform", "bluesky"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(Object.fromEntries(api.calls[0]!.url.searchParams), { from: "2026-11-01", to: "2026-11-30", platform: "bluesky" });
    assert.match(r.stdout, /^2026-11-01 to 2026-11-30: 12 posts, 5,400 followers \(\+120\), 1,200 views/);
    assert.match(r.stdout, /bluesky +ampost\.bsky\.social +12 +5,400 +\+120 +1,200 +30 +4 +- +up_to_date/);
    assert.match(r.stdout, /No analytics for: discord \(not_available_on_platform\)/);
  });

  it("lists post metrics and follower counts", async () => {
    const api = fakeApi({
      "GET /api/analytics/posts": reply(
        page([
          {
            postId: IDS.post,
            status: "published",
            text: "Hello",
            createdAt: "2026-11-22T10:00:00.000Z",
            platformPosts: [{ platform: "bluesky", accountId: IDS.account, platformSetId: IDS.set, platformPostId: "1", publishedUrl: null, publishedAt: "2026-11-22T10:00:00.000Z", contentType: null, analyticsStatus: "available", metrics, syncedAt: null }],
          },
        ]),
      ),
      "GET /api/analytics/followers": reply(
        page([
          { accountId: IDS.account, platform: "bluesky", platformSetId: IDS.set, username: "ampost.bsky.social", followers: 5400, syncedAt: "2026-11-22T00:00:00.000Z", totalLikes: null, history: [{ date: "2026-11-01", followers: 5000, syncedAt: "2026-11-01T00:00:00.000Z" }] },
        ]),
      ),
    });
    const posts = await cli(["analytics", "posts", "--post", IDS.post], { fetch: api.fetch });
    assert.equal(posts.code, EXIT.OK, posts.stderr);
    assert.equal(api.calls[0]!.url.searchParams.get("postId"), IDS.post);
    assert.match(posts.stdout, /bluesky +2026-11-22 10:00 UTC +1,200 +30 +4 +- +Hello/);

    const followers = await cli(["analytics", "followers"], { fetch: api.fetch });
    assert.match(followers.stdout, /bluesky +ampost\.bsky\.social +5,400 +\+400/);
  });

  it("refuses a bad date range", async () => {
    for (const argv of [["--from", "2026-11-31x"], ["--from", "2026-12-01", "--to", "2026-11-01"]]) {
      const r = await cli(["analytics", ...argv]);
      assert.equal(r.code, EXIT.USAGE, argv.join(" "));
    }
  });
});

describe("webhooks", () => {
  it("creates a webhook, expanding event groups, and shows the secret once", async () => {
    const api = fakeApi({ "POST /api/webhooks/endpoints": reply(webhookFixture({ secret: "whsec_full_secret" }), 201) });
    const r = await cli(["webhooks", "create", "--url", "https://example.com/hooks/ampost", "-e", "account.*,post.failed", "-e", "post.failed"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(api.calls[0]!.body, {
      url: "https://example.com/hooks/ampost",
      events: ["account.connected", "account.disconnected", "account.needs_reconnect", "post.failed"],
    });
    assert.match(r.stdout, /whsec_full_secret +\(shown once/);
  });

  it("updates only the given fields; an empty description clears it", async () => {
    const api = fakeApi({ [`PATCH /api/webhooks/endpoints/${IDS.webhook}`]: reply(webhookFixture()) });
    const r = await cli(["webhooks", "update", IDS.webhook, "--disable", "--description", "", "--rotate-secret"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.deepEqual(api.calls[0]!.body, { description: null, enabled: false, rotateSecret: true });
  });

  it("refuses bad webhook options without calling the API", async () => {
    const api = fakeApi({});
    const bad: string[][] = [
      ["create", "--url", "http://example.com", "-e", "post.failed"],
      ["create", "--url", "https://example.com"],
      ["create", "--url", "https://example.com", "-e", "post.exploded"],
      ["update", IDS.webhook],
      ["update", IDS.webhook, "--enable", "--disable"],
      ["delete", "123"],
    ];
    for (const argv of bad) {
      const r = await cli(["webhooks", ...argv], { fetch: api.fetch });
      assert.equal(r.code, EXIT.USAGE, argv.join(" "));
    }
    assert.equal(api.calls.length, 0);
  });

  it("lists webhooks and deliveries, tests and deletes", async () => {
    const delivery = {
      id: "88888888-8888-4888-8888-888888888888",
      webhookId: IDS.webhook,
      eventId: "e1",
      eventType: "webhook.test",
      status: "succeeded",
      attempts: 1,
      maxAttempts: 8,
      nextAttemptAt: null,
      lastAttemptAt: null,
      responseStatus: 200,
      responseBody: "ok",
      error: null,
      durationMs: 85,
      redeliveryOf: null,
      payload: {},
      createdAt: "2026-11-22T10:00:00.000Z",
    };
    const base = `/api/webhooks/endpoints/${IDS.webhook}`;
    const api = fakeApi({
      "GET /api/webhooks/endpoints": reply(page([webhookFixture()])),
      [`GET ${base}/deliveries`]: reply(page([delivery, delivery])),
      [`POST ${base}/test`]: reply(delivery),
      [`DELETE ${base}`]: reply({ id: IDS.webhook, deleted: true }),
    });
    assert.match((await cli(["webhooks", "list"], { fetch: api.fetch })).stdout, /https:\/\/example\.com\/hooks\/ampost +yes +1/);
    assert.match((await cli(["webhooks", "deliveries", IDS.webhook], { fetch: api.fetch })).stdout, /webhook\.test +succeeded +200 +1[\s\S]*2 deliveries\n$/);
    assert.match((await cli(["webhooks", "test", IDS.webhook], { fetch: api.fetch })).stdout, /Took: +85 ms/);
    assert.match((await cli(["webhooks", "delete", IDS.webhook], { fetch: api.fetch })).stdout, /Deleted webhook/);
  });
});
