# Ampost CLI

`ampost` posts to Instagram, Facebook, Threads, X, YouTube, Pinterest, Bluesky, Telegram and Discord
from your terminal, a shell script or an AI agent, through the [Ampost API](https://ampost.io/docs?ref=github).

- Publish now, schedule, add to a posting queue or save a draft, with local images and videos
- List, publish, retry, discard, unpublish and edit published posts; check or disconnect accounts; import a CSV of posts; read analytics; manage webhooks
- `--json` on every command, one JSON document on stdout, and documented exit codes
- Built on the [Node SDK](https://github.com/ampost-io/ampost-node), Node 18+

## Install

```sh
npx ampost-cli --help        # run it without installing
npm install -g ampost-cli    # or install the `ampost` command
```

## Quick start

Create an API key in [Settings, API keys](https://ampost.io/app/settings/api-keys?ref=github) and
connect Bluesky and Threads in the [dashboard](https://ampost.io/app?ref=github). Then:

```sh
ampost login                                  # paste the key; it is checked, then saved
ampost accounts list
ampost post "Hello from the Ampost CLI 👋" -p bluesky,threads
```

```
Post:     0b6c1e8a-4f0e-4d39-9a51-2b6f0c7d9e21 (created)
Status:   posting
Created:  2026-11-22 10:00 UTC
Text:     Hello from the Ampost CLI 👋

PLATFORM  STATUS      URL OR ERROR  ACCOUNT
bluesky   publishing                5d2f...
threads   publishing                9a1c...
```

Add `--wait` to wait until every platform has published and print the links.

`ampost help` lists every command, and `ampost <command> --help` shows its options and examples.

## Authentication

`ampost login` reads the key from a hidden prompt, or from stdin when stdin is not a terminal, checks
it against the API and saves it, readable by you only, in `config.json` in your config directory:

| OS | Directory |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/ampost` or `~/.config/ampost` |
| macOS | `~/Library/Application Support/ampost` |
| Windows | `%APPDATA%\ampost` |

`AMPOST_CONFIG_DIR` changes the directory. `AMPOST_API_KEY`, when set, is used instead of the saved key,
which is the simplest setup for CI and agents. `ampost status` shows which key is in use and
`ampost logout` deletes the saved one. There is no `--api-key` flag, so keys stay out of shell history.

A key has [scopes](https://ampost.io/docs?ref=github#scopes): a Read only key can list but not post.

## Posting

```sh
# Publish now (the default)
ampost post "We just shipped dark mode" -p bluesky,threads

# Schedule (ISO 8601 with a time; Z or an offset, else your machine's time zone)
ampost post "Webinar starts in one hour" -p threads --schedule 2026-12-01T09:00:00Z

# Next free slot of the platform set's posting queue, or a draft to finish in the dashboard
ampost post "Tip of the week" -p bluesky --queue
ampost post "Draft idea" -p threads --draft

# Local files are uploaded first; https URLs are passed as they are
ampost post "New office" -p bluesky,threads -m ./office.jpg -m ./team.jpg --alt-text "Our office" --alt-text "The team"

# A link and a first comment (a reply on Bluesky, Threads and X)
ampost post "Our pricing changed" -p bluesky --link https://example.com/pricing --first-comment "Questions? Ask below"

# Long text from a file or stdin
ampost post --text-file release-notes.md -p threads
git log -1 --format=%s | ampost post - -p bluesky

# Check without creating anything (local media is still uploaded, to check it)
ampost post "Does this fit?" -p bluesky,threads --dry-run

# Wait until every platform has finished, and fail if any did not publish
ampost post "Launch day" -p bluesky,threads --wait
```

`-p` takes `instagram`, `facebook`, `threads`, `twitter` (or `x`), `youtube`, `pinterest`, `bluesky`,
`telegram`, `discord`, `linkedin` and `tiktok`, from your default platform set. Use `--platform-set <id>`
(repeatable) for other sets; `ampost platform-sets list` shows them.

## Managing posts

```sh
ampost posts list --status failed
ampost posts list --platform threads --search "launch" --all
ampost posts get <post-id>
ampost posts publish <post-id> --wait                # publish a draft or scheduled post now
ampost posts retry <post-id> --wait                  # retry the failed platforms
ampost posts delete <post-id>                         # discard a draft, scheduled, queued or failed post
ampost posts unpublish <post-id>                      # delete a published post from the platforms
ampost posts edit-published <post-id> --text "Fixed"  # replace a published post's text on the platforms
ampost import-csv week.csv --dry-run && ampost import-csv week.csv --idempotency-key week-48
ampost accounts get <account-id>                      # can it post, and why not
ampost accounts disconnect <account-id>               # revoke Ampost's access; reconnect in the dashboard
```

Lists show 20 items; use `--limit`, `--offset` or `--all`. The CSV columns are those of the
dashboard's export ([reference](https://ampost.io/docs?ref=github#posts)).

## Analytics and webhooks

```sh
ampost analytics --from 2026-11-01 --to 2026-11-30
ampost analytics posts --platform bluesky
ampost analytics followers

ampost webhooks create --url https://example.com/hooks/ampost -e post.published,post.failed
ampost webhooks list
ampost webhooks test <webhook-id>
ampost webhooks deliveries <webhook-id>
ampost webhooks update <webhook-id> --disable
```

`webhooks create` prints the signing secret once. Payloads and signature checks are in the
[webhook docs](https://ampost.io/docs?ref=github#webhooks).

## Scripts and agents

With `--json` (anywhere on the command line) every command prints exactly one JSON document on stdout:
the API's response, or an error. Progress goes to stderr, and no command but `ampost login` on a
terminal asks for input.

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "status": 400, "details": { ... }, "requestId": "req_...", "exitCode": 6 } }
```

The exit code tells what happened without parsing anything:

| Code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Unexpected error, or `--wait` gave up while the post was still publishing |
| 2 | Wrong command, option or argument; nothing was sent |
| 3 | No API key, or the key was refused (401) |
| 4 | The key lacks a scope or platform set, or the plan lacks the feature (403) |
| 5 | Not found (404) |
| 6 | Invalid request or content (400, 413, 422), a failed `--dry-run`, or a CSV row with errors |
| 7 | The post's state does not allow it (409), for example deleting a published post |
| 8 | Rate limit or plan quota (429), after automatic retries |
| 9 | Ampost or the network is unavailable (5xx, timeout); retry later |
| 10 | `--wait`: the post failed or published only partly. `posts unpublish`: an account still has it (Instagram and TikTok have no delete API, or the platform refused). `posts edit-published`: an account kept its old text (Instagram, Threads, TikTok, Bluesky and X have no edit API, or the platform refused) |

A shell script that posts the day's release notes and stops on any failure:

```sh
#!/bin/sh
set -eu
export AMPOST_API_KEY="$AMPOST_KEY_FROM_YOUR_SECRET_STORE"

post=$(ampost post --text-file notes.md -p bluesky,threads --wait --json \
  --idempotency-key "notes-$(date +%F)")
echo "$post" | jq -r '.platformPosts[] | "\(.platform): \(.publishedUrl)"'
```

`--idempotency-key` makes a rerun of the same command safe: the API returns the first post instead
of creating a second one. Without it, each run creates a new post.

Branching on the outcome:

```sh
ampost post "$TEXT" -p bluesky --dry-run --json > check.json
case $? in
  0) ampost post "$TEXT" -p bluesky ;;
  6) jq -r '(.errors[], .targets[].errors[]) | .message' check.json ;;  # post-wide, then per platform
  3) echo "Set AMPOST_API_KEY" >&2 ;;
esac
```

For AI agents (Claude Code, Codex, Cursor and others), give the agent a key in `AMPOST_API_KEY` and
tell it to use `ampost <command> --json` and `ampost <command> --help`. The help text has examples,
and errors name the field that failed. Agents that speak MCP can use the hosted
[MCP server](https://ampost.io/docs/mcp?ref=github) instead.

## Environment

| Variable | Use |
| --- | --- |
| `AMPOST_API_KEY` | API key; overrides the one saved by `ampost login` |
| `AMPOST_BASE_URL` | API host, default `https://api.ampost.io` |
| `AMPOST_CONFIG_DIR` | Where `ampost login` saves the key |

## Development

```sh
(cd ../ampost-node && npm ci && npm run build)   # while the SDK is a local dependency
npm ci
npm run typecheck && npm test && npm run build
AMPOST_API_KEY=amp_... npm run test:smoke        # reads and validates only
node dist/bin.js --help
```

## Links

- [API docs](https://ampost.io/docs?ref=github) and [llms.txt](https://ampost.io/llms.txt?ref=github)
- [Node SDK](https://github.com/ampost-io/ampost-node), [Python SDK](https://github.com/ampost-io/ampost-python) and [Ruby SDK](https://github.com/ampost-io/ampost-ruby)
- [MCP server](https://ampost.io/docs/mcp?ref=github)
- [Pricing](https://ampost.io/pricing?ref=github)

## License

MIT
