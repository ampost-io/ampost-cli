import type { ListResponse, PagePromise } from "ampost";
import type { Input, OptionSpec } from "../cli.js";
import { UsageError } from "../errors.js";

export const PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "threads",
  "twitter",
  "discord",
  "telegram",
  "bluesky",
  "youtube",
  "pinterest",
] as const;
export type PlatformName = (typeof PLATFORMS)[number];

export function string(input: Input, name: string): string | undefined {
  const value = input.values[name];
  return typeof value === "string" ? value : undefined;
}

export function flag(input: Input, name: string): boolean {
  return input.values[name] === true;
}

/** A repeatable option whose values may also be comma-separated: `-p bluesky,threads -p x`. */
export function list(input: Input, name: string): string[] {
  const value = input.values[name];
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

/** A repeatable option taken as is (text may contain commas). */
export function repeated(input: Input, name: string): string[] {
  const value = input.values[name];
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

export function integer(input: Input, name: string, min: number, max: number): number | undefined {
  const value = string(input, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

export function platform(input: Input, name = "platform"): PlatformName | undefined {
  const value = string(input, name);
  if (value === undefined) return undefined;
  return checkPlatform(value);
}

export function checkPlatform(value: string): PlatformName {
  const normalized = value.toLowerCase() === "x" ? "twitter" : value.toLowerCase();
  if (!(PLATFORMS as readonly string[]).includes(normalized)) {
    throw new UsageError(`Unknown platform ${JSON.stringify(value)}. Platforms: ${PLATFORMS.join(", ")}`);
  }
  return normalized as PlatformName;
}

/** `YYYY-MM-DD`, as the analytics endpoints take it. */
export function day(input: Input, name: string): string | undefined {
  const value = string(input, name);
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new UsageError(`--${name} must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function oneOf<T extends string>(input: Input, name: string, allowed: readonly T[]): T | undefined {
  const value = string(input, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

export const LIST_OPTIONS: Record<string, OptionSpec> = {
  limit: { type: "string", value: "N", help: "Items per page, 1-100 (default 20)" },
  offset: { type: "string", value: "N", help: "Items to skip (default 0)" },
  all: { type: "boolean", help: "Fetch every page" },
};

/** `limit`/`offset` for the query; with `--all`, pages of 100. */
export function pageQuery(input: Input): { limit?: number; offset?: number } {
  const all = flag(input, "all");
  const limit = integer(input, "limit", 1, 100);
  const offset = integer(input, "offset", 0, Number.MAX_SAFE_INTEGER);
  if (all && offset !== undefined) throw new UsageError("--all starts at the first item: leave out --offset");
  return { ...((limit !== undefined || all) && { limit: limit ?? 100 }), ...(offset !== undefined && { offset }) };
}

/**
 * One page as the API returns it, or with `--all` every item in the same shape:
 * `{ data, pagination: { limit, offset: 0, total, hasMore: false } }`.
 */
export async function fetchList<T extends ListResponse>(page: PagePromise<T>, input: Input): Promise<T> {
  if (!flag(input, "all")) return await page;
  const data = await page.toArray();
  return { data, pagination: { limit: data.length, offset: 0, total: data.length, hasMore: false } } as unknown as T;
}

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are UUIDs; catching a typo here gives a clearer message than the API's 400. */
export function id(value: string | undefined, what: string): string {
  if (!value || !ID_PATTERN.test(value)) throw new UsageError(`${what} must be a UUID, got ${JSON.stringify(value ?? "")}`);
  return value;
}
