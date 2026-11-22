import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERSION } from "../src/cli.js";
import { COMMANDS } from "../src/commands/index.js";
import { EXIT } from "../src/errors.js";
import { accountFixture, apiError, cli, fakeApi, page, reply } from "./helpers.js";

describe("routing and help", () => {
  it("prints the command list and exit codes with no arguments", async () => {
    const r = await cli([]);
    assert.equal(r.code, EXIT.OK);
    for (const command of COMMANDS) assert.match(r.stdout, new RegExp(`\\n  ${command.name} `));
    assert.match(r.stdout, /Exit codes:/);
  });

  it("prints help for every command, with --help or `help <command>`", async () => {
    for (const command of COMMANDS) {
      const r = await cli([...command.name.split(" "), "--help"]);
      assert.equal(r.code, EXIT.OK, command.name);
      assert.match(r.stdout, new RegExp(`^ampost ${command.name}: `), command.name);
      assert.match(r.stdout, /--json/);
      const viaHelp = await cli(["help", ...command.name.split(" ")]);
      assert.equal(viaHelp.stdout, r.stdout);
    }
  });

  it("prints a group's commands for `ampost posts`", async () => {
    const r = await cli(["posts"]);
    assert.equal(r.code, EXIT.OK);
    assert.match(r.stdout, /ampost posts list/);
    assert.match(r.stdout, /ampost posts retry/);
  });

  it("prints the version", async () => {
    const r = await cli(["--version"]);
    assert.equal(r.stdout.trim(), VERSION);
    const j = await cli(["--json", "-v"]);
    assert.equal(j.json.version, VERSION);
    assert.equal(typeof j.json.sdkVersion, "string");
  });

  it("exits 2 on an unknown command, subcommand or option, and sends nothing", async () => {
    const api = fakeApi({});
    for (const argv of [["frobnicate"], ["posts", "bogus"], ["posts", "list", "--bogus"], ["--bogus", "posts", "list"], ["posts", "get"]]) {
      const r = await cli(argv, { fetch: api.fetch });
      assert.equal(r.code, EXIT.USAGE, argv.join(" "));
      assert.match(r.stderr, /^Error: /, argv.join(" "));
    }
    assert.equal(api.calls.length, 0);
  });

  it("prints usage errors as JSON on stdout with --json", async () => {
    const r = await cli(["posts", "list", "--limit", "500", "--json"]);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.stderr, "");
    assert.deepEqual(r.json.error, {
      code: "USAGE",
      message: "--limit must be a whole number from 1 to 100, got \"500\"",
      details: null,
      exitCode: 2,
    });
  });

  it("accepts --json before the command", async () => {
    const api = fakeApi({ "GET /api/accounts": reply(page([accountFixture()])) });
    const r = await cli(["--json", "accounts", "list"], { fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    assert.equal(r.json.data[0].username, "ampost.bsky.social");
  });

  it("treats `analytics` as `analytics overview`", async () => {
    const r = await cli(["analytics", "--help"]);
    assert.match(r.stdout, /^ampost analytics overview: /);
  });
});

describe("API errors and exit codes", () => {
  const cases: [number, string, number][] = [
    [400, "VALIDATION_FAILED", EXIT.INVALID],
    [401, "UNAUTHORIZED", EXIT.AUTH],
    [403, "INSUFFICIENT_SCOPE", EXIT.FORBIDDEN],
    [404, "POST_NOT_FOUND", EXIT.NOT_FOUND],
    [409, "INVALID_STATUS_TRANSITION", EXIT.CONFLICT],
    [413, "PAYLOAD_TOO_LARGE", EXIT.INVALID],
    [422, "ANALYTICS_UNAVAILABLE", EXIT.INVALID],
    [429, "RATE_LIMITED", EXIT.RATE_LIMITED],
    [500, "INTERNAL_ERROR", EXIT.UNAVAILABLE],
    [503, "SERVICE_UNAVAILABLE", EXIT.UNAVAILABLE],
  ];
  for (const [status, code, exit] of cases) {
    it(`maps HTTP ${status} to exit ${exit}`, async () => {
      const api = fakeApi({ "GET /api/accounts": apiError(status, code, "Nope", { issues: [{ path: "limit", message: "Too big" }] }) });
      const r = await cli(["accounts", "list"], { fetch: api.fetch });
      assert.equal(r.code, exit);
      assert.match(r.stderr, new RegExp(`Error: Nope \\(${code}, HTTP ${status}\\)`));
      assert.match(r.stderr, /- limit: Too big/);
      assert.match(r.stderr, /Request id: req_123/);
      assert.equal(r.stdout, "");

      const j = await cli(["accounts", "list", "--json"], { fetch: api.fetch });
      assert.equal(j.code, exit);
      assert.deepEqual(j.json, {
        error: { code, message: "Nope", status, details: { issues: [{ path: "limit", message: "Too big" }] }, requestId: "req_123", exitCode: exit },
      });
    });
  }

  it("exits 9 when the API cannot be reached", async () => {
    const r = await cli(["accounts", "list", "--json"], {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    assert.equal(r.code, EXIT.UNAVAILABLE);
    assert.equal(r.json.error.code, "CONNECTION_ERROR");
  });

  it("exits 3 without a key and tells how to get one", async () => {
    const api = fakeApi({});
    const r = await cli(["accounts", "list"], { env: { AMPOST_API_KEY: undefined }, fetch: api.fetch });
    assert.equal(r.code, EXIT.AUTH);
    assert.match(r.stderr, /ampost login/);
    assert.equal(api.calls.length, 0);
  });

  it("sends the key, a CLI user agent and AMPOST_BASE_URL", async () => {
    const api = fakeApi({ "GET https://staging.example.com/api/accounts": reply(page([])) });
    const r = await cli(["accounts", "list"], { env: { AMPOST_BASE_URL: "https://staging.example.com" }, fetch: api.fetch });
    assert.equal(r.code, EXIT.OK);
    const [call] = api.calls;
    assert.equal(call!.headers.get("authorization"), "Bearer amp_live_testkey_0123456789abcdef");
    assert.match(call!.headers.get("user-agent")!, /^ampost-cli\/\d+\.\d+\.\d+ ampost-node\//);
  });
});
