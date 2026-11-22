import type { Command } from "../cli.js";
import { pageNote, table } from "../format.js";
import { fetchList, id, LIST_OPTIONS, oneOf, pageQuery, platform, string } from "./shared.js";

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
