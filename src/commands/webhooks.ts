import type { Webhook, WebhooksCreateBody, WebhooksUpdateBody } from "ampost";
import type { Command, Input } from "../cli.js";
import { UsageError } from "../errors.js";
import { date, fields, pageNote, table } from "../format.js";
import { fetchList, flag, id, LIST_OPTIONS, list, pageQuery, string } from "./shared.js";

export const WEBHOOK_EVENTS = [
  "post.scheduled",
  "post.unscheduled",
  "post.discarded",
  "post.published",
  "post.partial",
  "post.failed",
  "post.platform.published",
  "post.platform.failed",
  "post.platform.deleted",
  "post.platform.edited",
  "account.connected",
  "account.disconnected",
  "account.needs_reconnect",
  "analytics.synced",
] as const;
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

function events(input: Input): WebhookEvent[] | undefined {
  const values = list(input, "events");
  if (values.length === 0) return undefined;
  const expanded = values.flatMap((value) => {
    // `post.*` takes every post event, `*` every event.
    if (value === "*") return [...WEBHOOK_EVENTS];
    if (value.endsWith(".*")) {
      const prefix = value.slice(0, -1);
      const matched = WEBHOOK_EVENTS.filter((e) => e.startsWith(prefix));
      if (matched.length) return matched;
    }
    if ((WEBHOOK_EVENTS as readonly string[]).includes(value)) return [value as WebhookEvent];
    throw new UsageError(`Unknown event ${JSON.stringify(value)}. Events: ${WEBHOOK_EVENTS.join(", ")}`);
  });
  return [...new Set(expanded)];
}

function url(input: Input): string | undefined {
  const value = string(input, "url");
  if (value !== undefined && !/^https:\/\//i.test(value)) throw new UsageError("--url must be a public https URL");
  return value;
}

function webhookText(w: Webhook, heading?: string): string {
  return fields([
    ["Webhook", heading ? `${w.id} (${heading})` : w.id],
    ["URL", w.url],
    ["Events", w.events.join(", ")],
    ["Enabled", w.enabled ? "yes" : `no${w.disabledReason ? ` (${w.disabledReason})` : ""}`],
    ["Description", w.description],
    ["Secret", w.secret ? `${w.secret}  (shown once: store it now to verify signatures)` : w.secretPreview],
    ["Last delivery", w.lastDeliveryAt ? date(w.lastDeliveryAt) : undefined],
    ["Failures", w.consecutiveFailures || undefined],
  ]);
}

const EVENTS_HELP = `Events, comma-separated: ${WEBHOOK_EVENTS.join(", ")}.
post.* or account.* takes a whole group, * every event. Payloads and signature checks:
https://ampost.io/docs?ref=cli#webhooks`;

export const webhooksList: Command = {
  name: "webhooks list",
  summary: "List webhook endpoints",
  options: { ...LIST_OPTIONS },
  async run(ctx, input) {
    const client = await ctx.client();
    const result = await fetchList(client.webhooks.list(pageQuery(input)), input);
    if (result.data.length === 0) return { data: result, text: "No webhooks." };
    const rows = result.data.map((w) => [w.id, w.url, w.enabled ? "yes" : "no", w.events.length, date(w.lastDeliveryAt)]);
    return {
      data: result,
      text: `${table(["id", "url", "enabled", "events", "last delivery"], rows)}\n\n${pageNote(result.pagination, result.data.length, "webhook")}`,
    };
  },
};

export const webhooksGet: Command = {
  name: "webhooks get",
  summary: "Show a webhook endpoint",
  args: "<webhook-id>",
  positionals: { min: 1, max: 1 },
  async run(ctx, input) {
    const client = await ctx.client();
    const w = await client.webhooks.get(id(input.positionals[0], "The webhook id"));
    return { data: w, text: webhookText(w) };
  },
};

export const webhooksCreate: Command = {
  name: "webhooks create",
  summary: "Send events to a URL (prints the signing secret once)",
  options: {
    url: { type: "string", value: "URL", help: "Public https URL that receives the events (required)" },
    events: { type: "string", short: "e", multiple: true, value: "LIST", help: "Events to send (required), e.g. post.published,post.failed" },
    description: { type: "string", value: "TEXT", help: "Your note, at most 200 characters" },
    "idempotency-key": { type: "string", value: "KEY", help: "Repeat the command safely with the same key" },
  },
  help: `${EVENTS_HELP}

Example:
  ampost webhooks create --url https://example.com/hooks/ampost -e post.published,post.failed`,
  async run(ctx, input) {
    const target = url(input);
    const chosen = events(input);
    if (!target) throw new UsageError("--url is required");
    if (!chosen) throw new UsageError("--events is required, e.g. -e post.published,post.failed");
    const description = string(input, "description");
    const body: WebhooksCreateBody = { url: target, events: chosen, ...(description !== undefined && { description }) };
    const client = await ctx.client();
    const key = string(input, "idempotency-key");
    const w = await client.webhooks.create(body, key ? { idempotencyKey: key } : {});
    return { data: w, text: webhookText(w, "created") };
  },
};

export const webhooksUpdate: Command = {
  name: "webhooks update",
  summary: "Change a webhook's URL, events, description or state; rotate its secret",
  args: "<webhook-id>",
  positionals: { min: 1, max: 1 },
  options: {
    url: { type: "string", value: "URL", help: "New https URL" },
    events: { type: "string", short: "e", multiple: true, value: "LIST", help: "New event list (replaces the old one)" },
    description: { type: "string", value: "TEXT", help: "New note; \"\" clears it" },
    enable: { type: "boolean", help: "Turn it on (clears the failure count)" },
    disable: { type: "boolean", help: "Turn it off" },
    "rotate-secret": { type: "boolean", help: "Replace the signing secret; the old one stops working at once" },
  },
  help: EVENTS_HELP,
  async run(ctx, input) {
    const webhookId = id(input.positionals[0], "The webhook id");
    if (flag(input, "enable") && flag(input, "disable")) throw new UsageError("Use --enable or --disable, not both");
    const target = url(input);
    const chosen = events(input);
    const description = string(input, "description");
    const body: WebhooksUpdateBody = {
      ...(target !== undefined && { url: target }),
      ...(chosen && { events: chosen }),
      ...(description !== undefined && { description: description === "" ? null : description }),
      ...(flag(input, "enable") && { enabled: true }),
      ...(flag(input, "disable") && { enabled: false }),
      ...(flag(input, "rotate-secret") && { rotateSecret: true }),
    };
    if (Object.keys(body).length === 0) throw new UsageError("Nothing to change: give --url, --events, --description, --enable, --disable or --rotate-secret");
    const client = await ctx.client();
    const w = await client.webhooks.update(webhookId, body);
    return { data: w, text: webhookText(w, "updated") };
  },
};

export const webhooksDelete: Command = {
  name: "webhooks delete",
  summary: "Delete a webhook endpoint",
  args: "<webhook-id>",
  positionals: { min: 1, max: 1 },
  async run(ctx, input) {
    const client = await ctx.client();
    const result = await client.webhooks.delete(id(input.positionals[0], "The webhook id"));
    return { data: result, text: `Deleted webhook ${result.id}` };
  },
};

export const webhooksTest: Command = {
  name: "webhooks test",
  summary: "Send a test event to a webhook now",
  args: "<webhook-id>",
  positionals: { min: 1, max: 1 },
  async run(ctx, input) {
    const client = await ctx.client();
    const d = await client.webhooks.test(id(input.positionals[0], "The webhook id"));
    return {
      data: d,
      text: fields([
        ["Delivery", d.id],
        ["Status", d.status],
        ["HTTP status", d.responseStatus],
        ["Took", d.durationMs === null ? undefined : `${d.durationMs} ms`],
        ["Error", d.error],
      ]),
    };
  },
};

export const webhooksDeliveries: Command = {
  name: "webhooks deliveries",
  summary: "Recent deliveries of a webhook, with their HTTP status",
  args: "<webhook-id>",
  positionals: { min: 1, max: 1 },
  options: { ...LIST_OPTIONS },
  async run(ctx, input) {
    const client = await ctx.client();
    const webhookId = id(input.positionals[0], "The webhook id");
    const result = await fetchList(client.webhooks.listDeliveries(webhookId, pageQuery(input)), input);
    if (result.data.length === 0) return { data: result, text: "No deliveries yet." };
    const rows = result.data.map((d) => [d.id, d.eventType, d.status, d.responseStatus, d.attempts, date(d.createdAt)]);
    return {
      data: result,
      text: `${table(["id", "event", "status", "http", "attempts", "created"], rows)}\n\n${pageNote(result.pagination, result.data.length, "delivery", "deliveries")}`,
    };
  },
};
