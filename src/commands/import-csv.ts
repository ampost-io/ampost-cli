import { readFile } from "node:fs/promises";
import type { ImportPostsCsvResult } from "ampost";
import type { Command } from "../cli.js";
import { EXIT, UsageError } from "../errors.js";
import { date, table } from "../format.js";
import { flag, string } from "./shared.js";

export const importCsv: Command = {
  name: "import-csv",
  summary: "Create many posts from a CSV file (one post per row)",
  args: "<file.csv | ->",
  positionals: { min: 1, max: 1 },
  options: {
    "dry-run": { type: "boolean", help: "Check every row; create nothing" },
    "idempotency-key": { type: "string", value: "KEY", help: "Run the same import again with the same key: no duplicates" },
  },
  help: `Columns: text, platforms (space-separated) or accountIds, platformSetId, scheduledFor or useQueue
(neither: a draft), linkUrl, firstComment, media (space-separated https URLs), altText,
text_<platform> and tiktok_<option>. The dashboard's CSV export imports again as it is.
Column reference: https://ampost.io/docs?ref=cli#posts

A bad row does not stop the others. Exit code 6 when any row has an error.

Examples:
  ampost import-csv week.csv --dry-run
  ampost import-csv week.csv --idempotency-key "week-48"`,
  async run(ctx, input) {
    const [path] = input.positionals;
    let csv: string;
    if (path === "-") {
      if (ctx.deps.io.stdinIsTTY) throw new UsageError("Reading the CSV from stdin, but stdin is a terminal: pipe the file in");
      csv = await ctx.deps.io.readStdin();
    } else {
      try {
        csv = await readFile(path!, "utf8");
      } catch (error) {
        throw new UsageError(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
    }
    if (!csv.trim()) throw new UsageError(`${path === "-" ? "stdin" : path} is empty`);

    const client = await ctx.client();
    const key = string(input, "idempotency-key");
    const result = await client.posts.importCsv({ csv, dryRun: flag(input, "dry-run") }, key ? { idempotencyKey: key } : {});
    return { data: result, text: importText(result), exitCode: result.summary.errors > 0 ? EXIT.INVALID : EXIT.OK };
  },
};

function importText(result: ImportPostsCsvResult): string {
  const { summary } = result;
  const lines = [
    result.dryRun
      ? `Dry run: ${summary.rows} rows, ${summary.valid} valid, ${summary.errors} with errors. Nothing was created.`
      : `Imported: ${summary.rows} rows, ${summary.created} posts created, ${summary.errors} with errors.`,
  ];
  for (const warning of result.warnings) lines.push(`warning: ${warning.column}: ${warning.message}`);
  const failed = result.rows.filter((row) => row.status === "error");
  if (failed.length) {
    const rows = failed.flatMap((row) => row.errors.map((error) => [row.row, error.column ?? "", `${error.message} (${error.code})`]));
    lines.push("", table(["row", "column", "error"], rows));
  }
  const created = result.rows.filter((row) => row.status === "created");
  if (created.length) {
    lines.push("", table(["row", "post", "scheduled"], created.map((row) => [row.row, row.postId, date(row.scheduledFor)])));
  }
  return lines.join("\n");
}
