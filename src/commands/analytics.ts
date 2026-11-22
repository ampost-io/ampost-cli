import type { AnalyticsMetrics } from "ampost";
import type { Command, Input, OptionSpec } from "../cli.js";
import { UsageError } from "../errors.js";
import { date, number, oneLine, pageNote, signed, table } from "../format.js";
import { day, fetchList, id, LIST_OPTIONS, pageQuery, platform, string } from "./shared.js";

const FILTERS: Record<string, OptionSpec> = {
  platform: { type: "string", value: "NAME", help: "Only accounts on this platform" },
  "platform-set": { type: "string", value: "ID", help: "Only accounts in this platform set" },
  account: { type: "string", value: "ID", help: "Only this account" },
};

const RANGE: Record<string, OptionSpec> = {
  from: { type: "string", value: "YYYY-MM-DD", help: "First day, UTC (default: 29 days before --to; at most 90 days)" },
  to: { type: "string", value: "YYYY-MM-DD", help: "Last day, UTC, included (default: today)" },
};

function filters(input: Input) {
  const setId = string(input, "platform-set");
  const accountId = string(input, "account");
  return {
    platform: platform(input),
    platformSetId: setId === undefined ? undefined : id(setId, "--platform-set"),
    accountId: accountId === undefined ? undefined : id(accountId, "--account"),
  };
}

function range(input: Input) {
  const from = day(input, "from");
  const to = day(input, "to");
  if (from && to && from > to) throw new UsageError("--from is after --to");
  return { from, to };
}

function metricCells(m: AnalyticsMetrics) {
  return [number(m.views), number(m.likes), number(m.comments), number(m.shares)];
}

export const analyticsOverview: Command = {
  name: "analytics overview",
  aliases: ["analytics"],
  summary: "Totals per account for a date range: posts, followers, views, likes, ...",
  options: { ...RANGE, ...FILTERS },
  help: `Examples:
  ampost analytics
  ampost analytics --from 2026-11-01 --to 2026-11-30 --platform instagram
  ampost analytics --json | jq '.totals.metrics'

Metrics a platform does not report are shown as - (null in JSON). Discord has no analytics.`,
  async run(ctx, input) {
    const client = await ctx.client();
    const result = await client.analytics.getOverview({ ...range(input), ...filters(input) });
    const t = result.totals;
    const lines = [
      `${result.from} to ${result.to}: ${number(t.posts)} posts, ${number(t.followers)} followers (${signed(t.followersChange)}), ` +
        `${number(t.metrics.views)} views, ${number(t.metrics.likes)} likes, ${number(t.metrics.comments)} comments`,
    ];
    if (result.accounts.length) {
      const rows = result.accounts.map((a) => [
        a.platform,
        a.username,
        number(a.posts),
        number(a.followers),
        signed(a.followersChange),
        ...metricCells(a.metrics),
        a.syncState,
      ]);
      lines.push("", table(["platform", "account", "posts", "followers", "change", "views", "likes", "comments", "shares", "sync"], rows));
    }
    if (result.unavailableAccounts.length) {
      lines.push("", `No analytics for: ${result.unavailableAccounts.map((a) => `${a.platform} (${a.reason})`).join(", ")}`);
    }
    return { data: result, text: lines.join("\n") };
  },
};

export const analyticsPosts: Command = {
  name: "analytics posts",
  summary: "Metrics of each published post, per platform",
  options: {
    post: { type: "string", value: "ID", help: "Only this post" },
    ...FILTERS,
    ...LIST_OPTIONS,
  },
  async run(ctx, input) {
    const postId = string(input, "post");
    const client = await ctx.client();
    const query = { ...pageQuery(input), ...filters(input), postId: postId === undefined ? undefined : id(postId, "--post") };
    const result = await fetchList(client.analytics.listPosts(query), input);
    if (result.data.length === 0) return { data: result, text: "No published posts with analytics." };
    const rows = result.data.flatMap((p) =>
      p.platformPosts.map((pp) => [p.postId, pp.platform, date(pp.publishedAt), ...metricCells(pp.metrics), oneLine(p.text, 30)]),
    );
    return {
      data: result,
      text: `${table(["post", "platform", "published", "views", "likes", "comments", "shares", "text"], rows)}\n\n${pageNote(result.pagination, result.data.length, "post")}`,
    };
  },
};

export const analyticsFollowers: Command = {
  name: "analytics followers",
  summary: "Follower counts per account, with daily history in --json",
  options: { ...RANGE, ...FILTERS, ...LIST_OPTIONS },
  async run(ctx, input) {
    const client = await ctx.client();
    const result = await fetchList(client.analytics.listFollowers({ ...pageQuery(input), ...range(input), ...filters(input) }), input);
    if (result.data.length === 0) return { data: result, text: "No accounts with follower counts." };
    const rows = result.data.map((a) => {
      const first = a.history[0]?.followers;
      const change = first === undefined || first === null || a.followers === null ? null : a.followers - first;
      return [a.platform, a.username, number(a.followers), signed(change), date(a.syncedAt)];
    });
    return {
      data: result,
      text: `${table(["platform", "account", "followers", "change in range", "synced"], rows)}\n\n${pageNote(result.pagination, result.data.length, "account")}`,
    };
  },
};
