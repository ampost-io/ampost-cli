import {
  AmpostError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  MediaUploadError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "ampost";

/**
 * Exit codes. Scripts and agents can branch on them; `--json` also prints the reason as
 * `{ "error": { "code", ... } }`. They are part of the CLI's public contract: add codes, never renumber.
 */
export const EXIT = {
  /** Done. */
  OK: 0,
  /** Anything else: an unexpected error, or `--wait` gave up while the post was still publishing. */
  ERROR: 1,
  /** Wrong command, option or argument. Nothing was sent to the API. */
  USAGE: 2,
  /** No API key, or the API refused it (401). Run `ampost login` or set AMPOST_API_KEY. */
  AUTH: 3,
  /** The key lacks a scope or platform set, or the plan lacks the feature (403). */
  FORBIDDEN: 4,
  /** No such post, account or webhook (404). */
  NOT_FOUND: 5,
  /** The request or its content is invalid (400, 413, 422), a `--dry-run` found errors, or a CSV row failed. */
  INVALID: 6,
  /** The resource's state does not allow it (409), for example deleting a published post. */
  CONFLICT: 7,
  /** Rate limit or plan quota (429), after the SDK's own retries. */
  RATE_LIMITED: 8,
  /** Ampost or the network failed (5xx, timeout, no connection). Safe to retry later. */
  UNAVAILABLE: 9,
  /** With `--wait`: the post failed on every platform or on some of them (`failed`, `partial`).
   * `posts unpublish`: an account still has the post (no delete API, or the platform refused).
   * `posts edit-published`: an account did not take the new text. */
  POST_FAILED: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A mistake in the command line. Exits with EXIT.USAGE. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** An error the CLI itself raises, with its exit code and a stable code for `--json`. */
export class CliError extends Error {
  override name = "CliError";
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof UsageError) return EXIT.USAGE;
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof AuthenticationError) return EXIT.AUTH;
  if (error instanceof PermissionDeniedError) return EXIT.FORBIDDEN;
  if (error instanceof NotFoundError) return EXIT.NOT_FOUND;
  if (error instanceof BadRequestError || error instanceof PayloadTooLargeError || error instanceof UnprocessableEntityError) {
    return EXIT.INVALID;
  }
  if (error instanceof ConflictError) return EXIT.CONFLICT;
  if (error instanceof RateLimitError) return EXIT.RATE_LIMITED;
  if (error instanceof InternalServerError || error instanceof APIConnectionError) return EXIT.UNAVAILABLE;
  if (error instanceof MediaUploadError) return error.reason === "timeout" ? EXIT.UNAVAILABLE : EXIT.INVALID;
  if (error instanceof APIError) return error.status >= 500 ? EXIT.UNAVAILABLE : EXIT.ERROR;
  // The SDK throws a plain AmpostError for a missing key.
  if (error instanceof AmpostError && /API key/.test(error.message)) return EXIT.AUTH;
  return EXIT.ERROR;
}

/** The `{ error }` document `--json` prints on failure. API errors keep the API's own code. */
export function errorJson(error: unknown): { error: Record<string, unknown> } {
  const exitCode = exitCodeFor(error);
  if (error instanceof APIError) {
    return {
      error: {
        code: error.code,
        message: messageOf(error),
        status: error.status,
        details: error.details ?? null,
        requestId: error.requestId ?? null,
        exitCode,
      },
    };
  }
  if (error instanceof CliError) {
    return { error: { code: error.code, message: error.message, details: error.details ?? null, exitCode } };
  }
  if (error instanceof MediaUploadError) {
    return { error: { code: "MEDIA_UPLOAD_FAILED", message: error.message, details: { reason: error.reason, uploadId: error.uploadId }, exitCode } };
  }
  const code =
    error instanceof UsageError
      ? "USAGE"
      : exitCode === EXIT.AUTH
        ? "MISSING_API_KEY"
        : error instanceof APIConnectionError
          ? "CONNECTION_ERROR"
          : "ERROR";
  return { error: { code, message: error instanceof Error ? error.message : String(error), details: null, exitCode } };
}

/** The API's message without the SDK's `400 CODE: ` prefix. */
function messageOf(error: APIError): string {
  const prefix = `${error.status} ${error.code}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/** Human-readable lines for stderr. */
export function errorText(error: unknown): string {
  if (error instanceof APIError) {
    const lines = [`Error: ${messageOf(error)} (${error.code}, HTTP ${error.status})`];
    const issues = error.details?.issues;
    if (Array.isArray(issues)) {
      for (const issue of issues.slice(0, 20)) lines.push(`  - ${issueText(issue)}`);
      if (issues.length > 20) lines.push(`  ... and ${issues.length - 20} more (use --json for all)`);
    }
    if (error instanceof AuthenticationError) lines.push("Run `ampost login` or set AMPOST_API_KEY.");
    if (error instanceof RateLimitError && error.retryAfterSeconds !== undefined) {
      lines.push(`Try again in ${error.retryAfterSeconds} s.`);
    }
    if (error.requestId) lines.push(`Request id: ${error.requestId}`);
    return lines.join("\n");
  }
  if (error instanceof UsageError) return `Error: ${error.message}\nRun \`ampost --help\` for usage.`;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function issueText(issue: unknown): string {
  if (!issue || typeof issue !== "object") return String(issue);
  const { path, message, code } = issue as { path?: unknown; message?: unknown; code?: unknown };
  // The API sends `media[0].url`; accept a path array too.
  const where = Array.isArray(path) ? (path.length ? `${path.join(".")}: ` : "") : typeof path === "string" && path ? `${path}: ` : "";
  return `${where}${typeof message === "string" ? message : JSON.stringify(issue)}${typeof code === "string" ? ` (${code})` : ""}`;
}
