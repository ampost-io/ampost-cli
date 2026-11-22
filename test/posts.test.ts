import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guessType, parseTime } from "../src/commands/posts.js";
import { EXIT } from "../src/errors.js";
import { apiError, cli, fakeApi, IDS, json, page, platformPost, postFixture, reply, tempDir, type Call } from "./helpers.js";

const created = (overrides: Record<string, unknown> = {}) => reply(postFixture(overrides), 201);

async function postBody(argv: string[], options: Parameters<typeof cli>[1] = {}) {
  const api = fakeApi({ "POST /api/posts": created() });
  const r = await cli(["post", ...argv], { fetch: api.fetch, ...options });
  assert.equal(r.code, EXIT.OK, r.stderr);
  return { body: api.calls[0]!.body as Record<string, unknown>, call: api.calls[0]!, r };
}

describe("ampost post", () => {
  it("publishes now by default, to the given platforms", async () => {
    const { body, call, r } = await postBody(["Hello world", "-p", "bluesky,threads", "-p", "x"]);
    assert.deepEqual(body, { text: "Hello world", targets: [{ platforms: ["bluesky", "threads", "twitter"] }], publishNow: true });
    assert.match(call.headers.get("idempotency-key")!, /^[0-9a-f-]{36}$/);
    assert.match(r.stdout, /Post: +11111111-1111-4111-8111-111111111111 \(created\)/);
    assert.match(r.stdout, /bluesky +published +https:\/\/bsky\.app\/profile\/x\/post\/1/);
  });

  it("schedules, queues or saves a draft", async () => {
    assert.deepEqual((await postBody(["Hi", "-p", "bluesky", "--schedule", "2026-12-01T09:00:00Z"])).body, {
      text: "Hi",
      targets: [{ platforms: ["bluesky"] }],
      scheduledFor: "2026-12-01T09:00:00.000Z",
    });
    assert.deepEqual((await postBody(["Hi", "-p", "bluesky", "--queue"])).body, {
      text: "Hi",
      targets: [{ platforms: ["bluesky"] }],
      useQueue: true,
    });
    assert.deepEqual((await postBody(["Hi", "-p", "bluesky", "--draft"])).body, { text: "Hi", targets: [{ platforms: ["bluesky"] }] });
  });

  it("sends one target per --platform-set, the link, first comment, metadata and idempotency key", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    const { body, call } = await postBody([
      "Hi",
      "-p",
      "threads",
      "--platform-set",
      IDS.set,
      "--platform-set",
      other,
      "--link",
      "https://ampost.io",
      "--first-comment",
      "More at the link",
      "--metadata",
      '{"source":"cron"}',
      "--idempotency-key",
      "post-2026-11-22",
    ]);
    assert.deepEqual(body, {
      text: "Hi",
      targets: [
        { platformSetId: IDS.set, platforms: ["threads"] },
        { platformSetId: other, platforms: ["threads"] },
      ],
      linkUrl: "https://ampost.io",
      firstComment: "More at the link",
      metadata: { source: "cron" },
      publishNow: true,
    });
    assert.equal(call.headers.get("idempotency-key"), "post-2026-11-22");
  });

  it("reads the text from stdin or a file, without the final newline", async () => {
    assert.equal((await postBody(["--text-file", "-", "-p", "bluesky"], { stdin: "From a pipe\n\n" })).body.text, "From a pipe");
    assert.equal((await postBody(["-", "-p", "bluesky"], { stdin: "Dash\n" })).body.text, "Dash");
    const file = join(tempDir(), "post.md");
    writeFileSync(file, "Line one\nLine two\n");
    assert.equal((await postBody(["--text-file", file, "-p", "bluesky"])).body.text, "Line one\nLine two");
  });

  it("passes https media URLs with a type from the extension and alt texts in order", async () => {
    const { body } = await postBody([
      "Hi",
      "-p",
      "instagram",
      "-m",
      "https://cdn.example.com/a.jpg",
      "-m",
      "https://cdn.example.com/clip.MP4?x=1",
      "--alt-text",
      "A photo",
    ]);
    assert.deepEqual(body.media, [
      { url: "https://cdn.example.com/a.jpg", type: "image", altText: "A photo" },
      { url: "https://cdn.example.com/clip.MP4?x=1", type: "video" },
    ]);
  });

  it("uploads local media files through the upload flow first", async () => {
    const file = join(tempDir(), "photo.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const uploaded = { url: "https://blob.ampost.io/u/photo.png", type: "image", mimeType: "image/png", sizeBytes: 4, width: 1, height: 1, durationSeconds: null };
    const api = fakeApi({
      "POST /api/media/uploads": reply({
        id: IDS.upload,
        uploadUrl: "https://storage.example.com/put/abc",
        method: "PUT",
        headers: { authorization: "Bearer storage-token" },
        uploadPageUrl: "https://ampost.io/upload/abc",
        expiresAt: "2026-11-22T11:00:00.000Z",
        limits: {},
      }),
      "PUT https://storage.example.com/put/abc": () => new Response(null, { status: 200 }),
      [`GET /api/media/uploads/${IDS.upload}`]: reply({ id: IDS.upload, status: "completed", error: null, files: [uploaded] }),
      "POST /api/posts": created(),
    });
    const r = await cli(["post", "Look", "-p", "instagram", "-m", file, "--alt-text", "Logo"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.match(r.stderr, /Uploading .*photo\.png/);
    assert.deepEqual(
      api.calls.map((c) => `${c.method} ${c.url.host}${c.path}`),
      ["POST api.ampost.io/api/media/uploads", "PUT storage.example.com/put/abc", `GET api.ampost.io/api/media/uploads/${IDS.upload}`, "POST api.ampost.io/api/posts"],
    );
    assert.deepEqual((api.calls[0]!.body as { fileName: string }).fileName, "photo.png");
    assert.equal(api.calls[1]!.headers.get("authorization"), "Bearer storage-token");
    assert.deepEqual((api.calls[3]!.body as { media: unknown }).media, [{ ...uploaded, altText: "Logo" }]);
  });

  it("checks with posts.validate on --dry-run: exit 0 when valid, 6 when not", async () => {
    const validation = (valid: boolean) => ({
      valid,
      errors: valid ? [] : [{ code: "CONTENT_TOO_LONG", message: "Text is longer than 300 characters", details: null }],
      warnings: [],
      scheduledFor: null,
      targets: [{ platform: "bluesky", platformSetId: IDS.set, accountId: IDS.account, valid, errors: [], warnings: [], mediaConversion: [] }],
    });
    const ok = fakeApi({ "POST /api/posts/validate": reply(validation(true)) });
    const r = await cli(["post", "Hi", "-p", "bluesky", "--dry-run"], { fetch: ok.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.match(r.stdout, /^Valid/);
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.calls[0]!.headers.get("idempotency-key"), null);

    const bad = fakeApi({ "POST /api/posts/validate": reply(validation(false)) });
    const j = await cli(["post", "x".repeat(400), "-p", "bluesky", "--dry-run", "--json"], { fetch: bad.fetch });
    assert.equal(j.code, EXIT.INVALID);
    assert.equal(j.json.valid, false);
    assert.equal(j.json.errors[0].code, "CONTENT_TOO_LONG");
  });

  it("--wait polls until the post is done: exit 0 published, 10 failed or partial", async () => {
    const posting = postFixture({ status: "posting", platformPosts: [platformPost({ status: "publishing", publishedUrl: null })] });
    const api = fakeApi({
      "POST /api/posts": reply(posting, 201),
      [`GET /api/posts/${IDS.post}`]: [reply(posting), reply(postFixture())],
    });
    const r = await cli(["post", "Hi", "-p", "bluesky", "--wait", "--json"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.json.status, "published");
    assert.deepEqual(r.slept, [3000, 3000]);

    const failed = postFixture({
      status: "partial",
      platformPosts: [
        platformPost(),
        platformPost({ platform: "threads", status: "failed", publishedUrl: null, error: { code: "MEDIA_REJECTED", message: "Bad image", retryable: false } }),
      ],
    });
    const api2 = fakeApi({ "POST /api/posts": reply(posting, 201), [`GET /api/posts/${IDS.post}`]: reply(failed) });
    const r2 = await cli(["post", "Hi", "-p", "bluesky,threads", "--wait"], { fetch: api2.fetch });
    assert.equal(r2.code, EXIT.POST_FAILED);
    assert.match(r2.stdout, /threads +failed +MEDIA_REJECTED: Bad image/);
  });

  it("--wait gives up after --wait-timeout with exit 1", async () => {
    const posting = postFixture({ status: "posting" });
    const api = fakeApi({ "POST /api/posts": reply(posting, 201), [`GET /api/posts/${IDS.post}`]: reply(posting) });
    const r = await cli(["post", "Hi", "-p", "bluesky", "--wait", "--wait-timeout", "1"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.stderr, /Still posting/);
  });

  it("refuses contradicting or missing options without calling the API", async () => {
    const api = fakeApi({});
    const bad: [string[], RegExp][] = [
      [["Hi"], /Choose platforms/],
      [["-p", "bluesky"], /Give the post text/],
      [["Hi", "-p", "myspace"], /Unknown platform "myspace"/],
      [["Hi", "-p", "bluesky", "--queue", "--draft"], /only one of --draft, --queue/],
      [["Hi", "-p", "bluesky", "--schedule", "tomorrow"], /ISO 8601/],
      [["Hi", "-p", "bluesky", "--schedule", "2026-12-01"], /needs a time too/],
      [["Hi", "-p", "bluesky", "--wait", "--draft"], /--wait works only when publishing now/],
      [["Hi", "-p", "bluesky", "--wait-timeout", "5"], /--wait-timeout needs --wait/],
      [["Hi", "-p", "bluesky", "-m", "./missing.jpg"], /no such file/],
      [["Hi", "-p", "bluesky", "-m", "http://insecure.example.com/a.jpg"], /must be https/],
      [["Hi", "-p", "bluesky", "--alt-text", "x"], /1 --alt-text for 0 --media/],
      [["Hi", "-p", "bluesky", "--metadata", "[1]"], /JSON object/],
      [["Hi", "-p", "bluesky", "--platform-set", "abc"], /--platform-set must be a UUID/],
      [["Hi", "-p", "bluesky", "--link", "ampost.io"], /--link must be an http/],
      [["Hi", "there", "-p", "bluesky"], /Too many arguments/],
      [["Hi", "--text-file", "x.md", "-p", "bluesky"], /not both/],
    ];
    for (const [argv, message] of bad) {
      const r = await cli(["post", ...argv], { fetch: api.fetch });
      assert.equal(r.code, EXIT.USAGE, argv.join(" "));
      assert.match(r.stderr, message, argv.join(" "));
    }
    assert.equal(api.calls.length, 0);
  });

  it("parses schedule times and media types", () => {
    assert.equal(parseTime("2026-12-01T09:00:00+02:00"), "2026-12-01T07:00:00.000Z");
    assert.equal(parseTime("2026-12-01 09:00Z"), "2026-12-01T09:00:00.000Z");
    assert.equal(guessType("https://x.com/a.webm"), "video");
    assert.equal(guessType("https://x.com/a.png#frag"), "image");
    assert.equal(guessType("https://x.com/noext"), "image");
  });
});

describe("ampost posts", () => {
  it("lists posts with filters and shows a table with a page note", async () => {
    const api = fakeApi({ "GET /api/posts": reply(page([postFixture()], { total: 45, hasMore: true })) });
    const r = await cli(["posts", "list", "--status", "failed", "--platform", "x", "--search", "launch", "--limit", "1"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    const query = Object.fromEntries(api.calls[0]!.url.searchParams);
    assert.deepEqual(query, { limit: "1", status: "failed", platform: "twitter", search: "launch" });
    assert.match(r.stdout, /^ID +STATUS +SCHEDULED\/CREATED +PLATFORMS +TEXT/);
    assert.match(r.stdout, /bluesky:published +Hello/);
    assert.match(r.stdout, /1-1 of 45 posts\. Next page: --offset 1/);
  });

  it("--all fetches every page and prints one list", async () => {
    const second = postFixture({ id: "77777777-7777-4777-8777-777777777777" });
    const api = fakeApi({
      "GET /api/posts": (call: Call) =>
        call.url.searchParams.get("offset") === "1"
          ? json(200, page([second], { limit: 100, offset: 1, total: 2, hasMore: false }))
          : json(200, page([postFixture()], { limit: 100, total: 2, hasMore: true })),
    });
    const r = await cli(["posts", "list", "--all", "--json"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(r.json.data.map((p: { id: string }) => p.id), [IDS.post, second.id]);
    assert.deepEqual(r.json.pagination, { limit: 2, offset: 0, total: 2, hasMore: false });
    assert.equal(api.calls[0]!.url.searchParams.get("limit"), "100");
  });

  it("gets a post, and exits 5 when it does not exist", async () => {
    const api = fakeApi({ [`GET /api/posts/${IDS.post}`]: [reply(postFixture()), apiError(404, "POST_NOT_FOUND", "Post not found")] });
    const r = await cli(["posts", "get", IDS.post, "--json"], { fetch: api.fetch });
    assert.equal(r.json.id, IDS.post);
    const missing = await cli(["posts", "get", IDS.post], { fetch: api.fetch });
    assert.equal(missing.code, EXIT.NOT_FOUND);
    const bad = await cli(["posts", "get", "not-an-id"], { fetch: api.fetch });
    assert.equal(bad.code, EXIT.USAGE);
  });

  it("retries the given accounts", async () => {
    const api = fakeApi({ [`POST /api/posts/${IDS.post}/retry`]: reply(postFixture({ status: "posting" })) });
    const r = await cli(["posts", "retry", IDS.post, "--account", IDS.account], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.deepEqual(api.calls[0]!.body, { accountIds: [IDS.account] });
    assert.ok(api.calls[0]!.headers.get("idempotency-key"));
    const all = await cli(["posts", "retry", IDS.post], { fetch: api.fetch });
    assert.equal(all.code, EXIT.OK);
    assert.deepEqual(api.calls[1]!.body, {});
  });

  it("discards a post, and exits 7 on a published one", async () => {
    const api = fakeApi({
      [`DELETE /api/posts/${IDS.post}`]: [reply(postFixture({ status: "discarded" })), apiError(409, "INVALID_STATUS_TRANSITION", "A published post cannot be changed.")],
    });
    const r = await cli(["posts", "delete", IDS.post], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.match(r.stdout, /discarded/);
    const again = await cli(["posts", "delete", IDS.post], { fetch: api.fetch });
    assert.equal(again.code, EXIT.CONFLICT);
  });

  it("unpublishes a post, and exits 10 while an account still has it", async () => {
    const notice = { code: "UNPUBLISH_NOT_SUPPORTED", message: "This platform has no API to delete a published post.", retryable: false, platformCode: null, platformSubcode: null };
    const api = fakeApi({
      [`POST /api/posts/${IDS.post}/unpublish`]: [
        reply(postFixture({ status: "deleted", platformPosts: [platformPost({ status: "deleted", publishedUrl: null })] })),
        reply(postFixture({ status: "published", platformPosts: [platformPost({ platform: "instagram", notice })] })),
      ],
    });
    const r = await cli(["posts", "unpublish", IDS.post, "--account", IDS.account], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.equal(api.calls[0]!.method, "POST");
    assert.deepEqual(api.calls[0]!.body, { accountIds: [IDS.account] });
    assert.match(r.stdout, /unpublished/);
    const kept = await cli(["posts", "unpublish", IDS.post], { fetch: api.fetch });
    assert.equal(kept.code, EXIT.POST_FAILED);
    assert.deepEqual(api.calls[1]!.body, {});
    assert.match(kept.stdout, /instagram: still published\. This platform has no API .* \(UNPUBLISH_NOT_SUPPORTED\)/);
    const bad = await cli(["posts", "unpublish", "not-an-id"], { fetch: api.fetch });
    assert.equal(bad.code, EXIT.USAGE);
  });

  it("publishes a draft now, with an idempotency key", async () => {
    const api = fakeApi({ [`POST /api/posts/${IDS.post}/publish`]: reply(postFixture({ status: "posting" })) });
    const r = await cli(["posts", "publish", IDS.post, "--idempotency-key", "go-1"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(api.calls[0]!.headers.get("idempotency-key"), "go-1");
    assert.match(r.stdout, /\(publishing\)/);
    assert.equal((await cli(["posts", "publish", IDS.post, "--wait-timeout", "5"], { fetch: api.fetch })).code, EXIT.USAGE);
  });

  it("edits a published post's text, and exits 10 while an account keeps its old text", async () => {
    const notice = { code: "EDIT_NOT_SUPPORTED", message: "Threads has no API to edit a published post.", retryable: false, platformCode: null, platformSubcode: null };
    const api = fakeApi({
      [`POST /api/posts/${IDS.post}/edit-published`]: [
        reply(postFixture({ platformPosts: [platformPost({ text: "Fixed" })] })),
        reply(postFixture({ platformPosts: [platformPost({ text: "Fixed" }), platformPost({ platform: "threads", notice })] })),
      ],
    });
    const r = await cli(["posts", "edit-published", IDS.post, "--text", "Fixed", "--account", IDS.account], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.equal(api.calls[0]!.method, "POST");
    assert.deepEqual(api.calls[0]!.body, { text: "Fixed", accountIds: [IDS.account] });
    assert.match(r.stdout, /\(edited\)/);
    const kept = await cli(["posts", "edit-published", IDS.post, "--text", "Fixed"], { fetch: api.fetch });
    assert.equal(kept.code, EXIT.POST_FAILED);
    assert.deepEqual(api.calls[1]!.body, { text: "Fixed" });
    assert.match(kept.stdout, /threads: not edited\. Threads has no API .* \(EDIT_NOT_SUPPORTED\)/);
    const file = join(tempDir(), "new.txt");
    writeFileSync(file, "From a file\n");
    assert.equal((await cli(["posts", "edit-published", IDS.post, "--text", "x", "--text-file", file], { fetch: api.fetch })).code, EXIT.USAGE);
    assert.equal((await cli(["posts", "edit-published", IDS.post], { fetch: api.fetch })).code, EXIT.USAGE);
    assert.equal(api.calls.length, 2);
  });
});
