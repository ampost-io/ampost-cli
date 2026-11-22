import type { Command } from "../cli.js";
import { accountsList, platformSetsList } from "./accounts.js";
import { analyticsFollowers, analyticsOverview, analyticsPosts } from "./analytics.js";
import { login, logout, status } from "./auth.js";
import { importCsv } from "./import-csv.js";
import { post, postsDelete, postsGet, postsList, postsRetry, postsUnpublish } from "./posts.js";
import {
  webhooksCreate,
  webhooksDeliveries,
  webhooksDelete,
  webhooksGet,
  webhooksList,
  webhooksTest,
  webhooksUpdate,
} from "./webhooks.js";

/** In the order `ampost --help` lists them. */
export const COMMANDS: Command[] = [
  login,
  logout,
  status,
  accountsList,
  platformSetsList,
  post,
  postsList,
  postsGet,
  postsRetry,
  postsDelete,
  postsUnpublish,
  importCsv,
  analyticsOverview,
  analyticsPosts,
  analyticsFollowers,
  webhooksList,
  webhooksGet,
  webhooksCreate,
  webhooksUpdate,
  webhooksDelete,
  webhooksTest,
  webhooksDeliveries,
];

/** Command groups: `ampost <group>` alone prints the group's help. */
export const GROUPS: Record<string, string> = {
  accounts: "connected social accounts",
  "platform-sets": "platform sets (one account per platform each)",
  posts: "list, read, retry, discard and unpublish posts (create them with `ampost post`)",
  analytics: "post metrics, account totals and followers",
  webhooks: "send post and account events to your URL",
};
