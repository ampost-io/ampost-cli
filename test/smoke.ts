// Smoke test against the real API. Runs only with AMPOST_API_KEY set (a Read only key is enough);
// it reads and validates, and never creates, publishes or deletes anything.
//   AMPOST_API_KEY=amp_... npm run test:smoke
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT } from "../src/errors.js";
import { cli } from "./helpers.js";

const apiKey = process.env.AMPOST_API_KEY;
const env = { AMPOST_API_KEY: apiKey, AMPOST_BASE_URL: process.env.AMPOST_BASE_URL };

describe("smoke: real API", { skip: apiKey ? false : "AMPOST_API_KEY is not set" }, () => {
  it("lists accounts and posts as JSON", async () => {
    const accounts = await cli(["accounts", "list", "--json"], { env });
    assert.equal(accounts.code, EXIT.OK, accounts.stdout);
    assert.ok(Array.isArray(accounts.json.data));
    const posts = await cli(["posts", "list", "--limit", "1", "--json"], { env });
    assert.equal(posts.code, EXIT.OK, posts.stdout);
    assert.equal(typeof posts.json.pagination.total, "number");
  });

  it("prints readable tables", async () => {
    const r = await cli(["posts", "list", "--limit", "3"], { env });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.ok(r.stdout.length > 0);
  });

  it("checks a post with --dry-run without creating it", async () => {
    const accounts = await cli(["accounts", "list", "--limit", "2", "--json"], { env });
    const platforms: string[] = accounts.json.data.length ? [...new Set(accounts.json.data.map((a: { platform: string }) => a.platform))] as string[] : ["bluesky"];
    const r = await cli(["post", "Smoke test from ampost-cli", "-p", platforms.join(","), "--dry-run", "--json"], { env });
    assert.ok(r.code === EXIT.OK || r.code === EXIT.INVALID, r.stdout);
    assert.equal(typeof r.json.valid, "boolean");
  });

  it("exits 3 on a wrong key", async () => {
    const r = await cli(["accounts", "list", "--json"], { env: { ...env, AMPOST_API_KEY: "amp_not_a_real_key" } });
    assert.equal(r.code, EXIT.AUTH);
    assert.equal(r.json.error.status, 401);
  });
});
