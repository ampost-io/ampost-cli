import type { Account } from "ampost";
import type { Command } from "../cli.js";
import { fields, pageNote, table } from "../format.js";
import { fetchList, id, LIST_OPTIONS, oneOf, pageQuery, platform, string } from "./shared.js";

function accountText(a: Pick<Account, "id" | "platform" | "username" | "status" | "tokenHealth" | "platformSetId" | "health">, heading?: string): string {
  const head = fields([
    ["Account", heading ? `${a.id} (${heading})` : a.id],
    ["Platform", a.platform],
    ["Username", a.username ?? undefined],
    ["Status", a.status],
    ["Token", a.tokenHealth],
    ["Platform set", a.platformSetId ?? undefined],
    ["Can post", a.health.canPost ? "yes" : "no"],
    ["Reconnect", a.health.needsReconnect ? "needed: https://ampost.io/app?ref=cli" : undefined],
  ]);
  const issues = a.health.issues.map((i) => `  ${i.severity}: ${i.message} (${i.code})`);
  return issues.length ? `${head}\n\nIssues:\n${issues.join("\n")}` : head;
}

export const accountsGet: Command = {
  name: "accounts get",
  summary: "Show an account and whether it can post",
  args: "<account-id>",
  positionals: { min: 1, max: 1 },
  async run(ctx, input) {
    const client = await ctx.client();
    const a = await client.accounts.get(id(input.positionals[0], "The account id"));
    return { data: a, text: accountText(a) };
  },
};

export const accountsDisconnect: Command = {
  name: "accounts disconnect",
  summary: "Disconnect an account: revoke Ampost's access and delete its tokens",
  args: "<account-id>",
  positionals: { min: 1, max: 1 },
  help: `The account becomes \`revoked\` and its scheduled posts will fail. It keeps its id: reconnect it in
the dashboard. Ampost revokes its access at the platform where the platform allows it; Instagram and
Threads have no revoke API, so remove Ampost in their settings (the output says where).

Example:
  ampost accounts disconnect <account-id>`,
  async run(ctx, input) {
    const client = await ctx.client();
    const a = await client.accounts.disconnect(id(input.positionals[0], "The account id"));
    const revoke = a.providerRevoked
      ? "The platform confirmed the revoke."
      : `The platform did not confirm a revoke.${a.providerAccessSettings ? ` Remove Ampost at ${a.providerAccessSettings}` : ""}`;
    return { data: a, text: `${accountText(a, "disconnected")}\n\n${revoke}` };
  },
};

export const accountsList: Command = {
  name: "accounts list",
  summary: "List connected social accounts",
  options: {
    platform: { type: "string", value: "NAME", help: "Only this platform (bluesky, threads, instagram, ...)" },
    "platform-set": { type: "string", value: "ID", help: "Only accounts in this platform set" },
    status: { type: "string", value: "STATUS", help: "active (default), revoked or all" },
    ...LIST_OPTIONS,
  },
  help: "Connect accounts in the dashboard: https://ampost.io/app?ref=cli",
  async run(ctx, input) {
    const setId = string(input, "platform-set");
    const query = {
      ...pageQuery(input),
      platform: platform(input),
      status: oneOf(input, "status", ["active", "revoked", "all"] as const),
      platformSetId: setId === undefined ? undefined : id(setId, "--platform-set"),
    };
    const client = await ctx.client();
    const result = await fetchList(client.accounts.list(query), input);
    if (result.data.length === 0) return { data: result, text: "No accounts. Connect one at https://ampost.io/app?ref=cli" };
    const rows = result.data.map((a) => [a.id, a.platform, a.username, a.status, a.tokenHealth, a.platformSetId]);
    return {
      data: result,
      text: `${table(["id", "platform", "username", "status", "token", "platform set"], rows)}\n\n${pageNote(result.pagination, result.data.length, "account")}`,
    };
  },
};

export const platformSetsList: Command = {
  name: "platform-sets list",
  summary: "List platform sets (one account per platform each; use with --platform-set)",
  options: { ...LIST_OPTIONS },
  async run(ctx, input) {
    const client = await ctx.client();
    const result = await fetchList(client.platformSets.list(pageQuery(input)), input);
    if (result.data.length === 0) return { data: result, text: "No platform sets." };
    const rows = result.data.map((s) => [s.id, s.name, s.isDefault ? "yes" : "", s.accountCount]);
    return {
      data: result,
      text: `${table(["id", "name", "default", "accounts"], rows)}\n\n${pageNote(result.pagination, result.data.length, "platform set")}`,
    };
  },
};
