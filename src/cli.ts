import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Ampost, VERSION as SDK_VERSION } from "ampost";
import { COMMANDS, GROUPS } from "./commands/index.js";
import { resolveCredentials, type Env } from "./config.js";
import { CliError, errorJson, errorText, EXIT, UsageError, type ExitCode } from "./errors.js";

export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface Deps {
  env: Env;
  io: Io;
  /** For tests and proxies. Default: the global fetch. */
  fetch?: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  readStdin(): Promise<string>;
  /** Asks on the terminal without echoing the answer. */
  promptSecret(question: string): Promise<string>;
}

export interface OptionSpec {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  /** Placeholder in help, e.g. `ID`. */
  value?: string;
  help: string;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Input {
  positionals: string[];
  values: Values;
}

export interface Output {
  /** Printed as JSON with `--json`. */
  data: unknown;
  /** Printed otherwise. */
  text: string;
  exitCode?: ExitCode;
}

export interface Context {
  deps: Deps;
  json: boolean;
  /** An API client with the key from AMPOST_API_KEY or `ampost login`. */
  client(): Promise<Ampost>;
  /** Progress for people, on stderr; silent with `--json`. */
  progress(message: string): void;
}

export interface Command {
  /** Words after `ampost`, e.g. `posts list`. */
  name: string;
  /** Other names, e.g. `analytics` for `analytics overview`. */
  aliases?: string[];
  summary: string;
  /** Positional arguments in help, e.g. `<post-id>`. */
  args?: string;
  positionals?: { min: number; max: number };
  options?: Record<string, OptionSpec>;
  /** Extra help: details and examples. */
  help?: string;
  run(ctx: Context, input: Input): Promise<Output>;
}

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", help: "Print JSON: the API's response, or { \"error\": {...} } on failure. Always one document on stdout" },
  help: { type: "boolean", short: "h", help: "Show help" },
};

/** Runs one command line and returns the exit code. Never throws. */
export async function run(argv: string[], deps: Deps): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { command, rest, help, version } = route(argv);
    if (version) return print(deps, json, { version: VERSION, sdkVersion: SDK_VERSION }, VERSION);
    if (!command) return print(deps, json, null, help ?? mainHelp(), EXIT.OK);

    const input = parse(command, rest);
    json = input.values.json === true;
    if (input.values.help) return print(deps, false, null, commandHelp(command), EXIT.OK);
    const output = await command.run(context(deps, json), input);
    return print(deps, json, output.data, output.text, output.exitCode ?? EXIT.OK);
  } catch (error) {
    const code = exitCodeOf(error);
    if (json) deps.io.stdout(`${JSON.stringify(errorJson(error), null, 2)}\n`);
    else deps.io.stderr(`${errorText(error)}\n`);
    return code;
  }
}

function exitCodeOf(error: unknown): number {
  return errorJson(error).error.exitCode as number;
}

function print(deps: Deps, json: boolean, data: unknown, text: string, exitCode: number = EXIT.OK): number {
  if (json) deps.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  else if (text) deps.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
  return exitCode;
}

function context(deps: Deps, json: boolean): Context {
  let client: Ampost | undefined;
  return {
    deps,
    json,
    async client() {
      if (client) return client;
      const credentials = await resolveCredentials(deps.env);
      if (!credentials) {
        throw new CliError(
          "No API key. Run `ampost login`, or set AMPOST_API_KEY. Create a key at https://ampost.io/app/settings/api-keys?ref=cli",
          EXIT.AUTH,
          "MISSING_API_KEY",
        );
      }
      client = new Ampost({
        apiKey: credentials.apiKey,
        ...(credentials.baseUrl && { baseUrl: credentials.baseUrl }),
        ...(deps.fetch && { fetch: deps.fetch }),
        defaultHeaders: { "User-Agent": `ampost-cli/${VERSION} ampost-node/${SDK_VERSION}` },
      });
      return client;
    },
    progress(message) {
      if (!json) deps.io.stderr(`${message}\n`);
    },
  };
}

/**
 * Finds the command. `--json`, `--help` and `--version` may come before it; the command's own options come
 * after it. Returns help text instead of a command for `ampost`, `ampost help ...` and `ampost <group>`.
 */
function route(argv: string[]): { command?: Command; rest: string[]; help?: string; version?: boolean } {
  let i = 0;
  for (; i < argv.length && argv[i]!.startsWith("-"); i++) {
    const flag = argv[i]!;
    if (flag === "--version" || flag === "-v") return { rest: [], version: true };
    if (!["--json", "--help", "-h"].includes(flag)) throw new UsageError(`Unknown option ${flag} before the command`);
  }
  const words = argv.slice(i);
  if (words[0] === "help") {
    const target = words.slice(1).filter((word) => !word.startsWith("-"));
    if (target.length === 0) return { rest: [], help: mainHelp() };
    return helpFor(target);
  }
  if (words.length === 0) return { rest: [], help: mainHelp() };
  if (argv.slice(0, i).some((flag) => flag === "--help" || flag === "-h") && !match(words)) return helpFor(words);

  const found = match(words);
  if (!found) {
    if (GROUPS[words[0]!]) {
      if (words.length === 1 || words[1]!.startsWith("-")) return { rest: [], help: groupHelp(words[0]!) };
      throw new UsageError(`Unknown command \`ampost ${words[0]} ${words[1]}\`. ${groupCommands(words[0]!)}`);
    }
    throw new UsageError(`Unknown command \`${words[0]}\``);
  }
  // Global options given before the command are parsed with the command's own.
  const rest = [...argv.slice(0, i), ...words.slice(found.length)];
  return { command: found.command, rest };
}

function match(words: string[]): { command: Command; length: number } | undefined {
  for (const length of [2, 1]) {
    const name = words.slice(0, length).join(" ");
    const command = COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
    if (command && words.length >= length) return { command, length };
  }
  return undefined;
}

function helpFor(target: string[]): { rest: string[]; help: string } {
  const found = match(target);
  if (found) return { rest: [], help: commandHelp(found.command) };
  if (GROUPS[target[0]!]) return { rest: [], help: groupHelp(target[0]!) };
  throw new UsageError(`Unknown command \`${target.join(" ")}\``);
}

function parse(command: Command, args: string[]): Input {
  const options = { ...command.options, ...GLOBAL_OPTIONS };
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: Object.fromEntries(
        Object.entries(options).map(([name, spec]) => [
          name,
          { type: spec.type, ...(spec.multiple && { multiple: true }), ...(spec.short && { short: spec.short }) },
        ]),
      ),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message.replace(/\. To specify a positional argument.*$/s, "")} (ampost ${command.name} --help)`);
  }
  const { positionals } = parsed;
  const values = parsed.values as Values;
  if (values.help) return { positionals, values };
  const { min, max } = command.positionals ?? { min: 0, max: 0 };
  if (positionals.length < min) throw new UsageError(`Missing ${command.args ?? "argument"}: ampost ${command.name} ${command.args ?? ""}`.trim());
  if (positionals.length > max) {
    throw new UsageError(
      max === 0
        ? `\`ampost ${command.name}\` takes no arguments, got ${JSON.stringify(positionals[0])}`
        : `Too many arguments for \`ampost ${command.name}\`: ${JSON.stringify(positionals.slice(max))}. Quote text with spaces`,
    );
  }
  return { positionals, values };
}

export function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;
  return [
    "ampost: publish and schedule posts on Instagram, Facebook, Threads, X, YouTube, Pinterest, Bluesky,",
    "Telegram and Discord from your shell. Docs: https://ampost.io/docs?ref=cli",
    "",
    "Usage: ampost <command> [options] [--json]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
    "",
    "Global options:",
    "  --json         Print JSON on stdout (errors too, as { \"error\": {...} }); for scripts and agents",
    "  -h, --help     Help for any command: ampost post --help",
    "  -v, --version  Print the version",
    "",
    "Authentication: `ampost login`, or the AMPOST_API_KEY environment variable (it wins over the login).",
    "",
    exitCodesHelp(),
  ].join("\n");
}

export function exitCodesHelp(): string {
  return [
    "Exit codes:",
    "  0 ok    1 error    2 usage    3 no or bad API key    4 forbidden (scope, plan)    5 not found",
    "  6 invalid request, failed dry run or CSV rows    7 conflict    8 rate limited    9 API unavailable",
    "  10 post failed or partial (--wait)",
  ].join("\n");
}

function groupCommands(group: string): string {
  return `Commands: ${COMMANDS.filter((c) => c.name.startsWith(`${group} `)).map((c) => c.name.split(" ")[1]).join(", ")}`;
}

function groupHelp(group: string): string {
  const commands = COMMANDS.filter((c) => c.name === group || c.name.startsWith(`${group} `));
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  return [
    `ampost ${group}: ${GROUPS[group]}`,
    "",
    ...commands.map((c) => `  ampost ${c.name.padEnd(width)}${c.summary}`),
    "",
    `Help for one: ampost ${commands[0]!.name} --help`,
  ].join("\n");
}

export function commandHelp(command: Command): string {
  const options = Object.entries({ ...command.options, json: GLOBAL_OPTIONS.json! });
  const label = ([name, spec]: [string, OptionSpec]) =>
    `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.type === "string" ? ` ${spec.value ?? "VALUE"}` : ""}`;
  const width = Math.max(...options.map((o) => label(o).length)) + 2;
  return [
    `ampost ${command.name}: ${command.summary}`,
    "",
    `Usage: ampost ${command.name}${command.args ? ` ${command.args}` : ""}${options.length > 1 ? " [options]" : ""}`,
    "",
    "Options:",
    ...options.map((o) => `  ${label(o).padEnd(width)}${o[1].help}${o[1].multiple ? " (repeatable)" : ""}`),
    ...(command.help ? ["", command.help.trimEnd()] : []),
  ].join("\n");
}
