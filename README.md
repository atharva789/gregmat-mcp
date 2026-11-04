# gregmat-mcp

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Desktop, Claude Code, Cursor, …) read your [GregMAT](https://gregmat.com) GRE prep progress, plus a local study log for anything GregMAT doesn't track.

> GregMAT has no public API. Endpoints were inferred from the site's public JS bundles **without logging in**. Auth endpoints are confirmed; most response shapes are guesses. Run `npm run check` once with your credentials to see what works, then see [Fixing guessed endpoints](#fixing-guessed-endpoints).

## What it does

| Tool | What it returns |
|---|---|
| `get_profile` | Name, email, subscription, ids (`/authentication/me/`) |
| `get_progress_summary` | Problem-solving + skill-building stats, solved counts by section/topic, study plan %, local log, last activity, streak, days until test |
| `list_completed_items` | Solved/attempted problems, quiz attempts, study-plan units done (`video`), skill-building counts (`skill`), merged with the local log. Args: `type`, `since`, `limit` |
| `get_quiz_results` | Scores/attempts per quiz. Args: `slug` (one quiz) or `group` (quiz group / super group) |
| `get_diagnostics` | **Derived** accuracy by topic and Quant vs Verbal, weakest N topics, unattempted high-yield topics. Optional sectional-tests scrape |
| `get_study_plan_progress` | Units done/total, next undone units, units/day needed to finish by test day. Arg: `slug` |
| `raw_get` | Debugging: GET an allowlisted API path and see the raw JSON |
| `log_solved_problem` | Append to the **local** log (`source`, `section`, `topic`, `item`, `correct`, `score`, `time_minutes`, `notes`, `date`) |
| `list_local_log` | Local log entries + stats. Args: `since`, `section`, `topic` |

The server only sends GET requests to GregMAT. The only POSTs are login and token refresh. It never marks anything done, submits answers, or changes your account. If a GregMAT call fails, the tool returns `{error, endpoint, status, hint}` and still includes local-log data where it's relevant. The server doesn't crash on these errors.

## Setup

Requires Node.js 18+.

```bash
git clone <this repo> gregmat-mcp
cd gregmat-mcp
npm install          # also builds (prepare → tsc)
npm run build        # if you change src/
npm test             # offline smoke test, no credentials needed
```

Run it directly with `node dist/index.js` (stdio), or `npx gregmat-mcp` from the repo. Other commands: `node dist/index.js --help` and `npm run check` (self-test).

### Credentials (pick one)

| Env var | Notes |
|---|---|
| `GREGMAT_TOKEN` | **Recommended. Works for Google/Apple sign-in.** Log in on gregmat.com → DevTools → Application → Cookies → `https://gregmat.com` → copy the value of `piniaAccess`. It lasts about 7 days. |
| `GREGMAT_COOKIE` | The whole `Cookie:` header from a logged-in gregmat.com request. `piniaAccess` is extracted. |
| `GREGMAT_EMAIL` + `GREGMAT_PASSWORD` | Email/password login. The access and refresh tokens are cached in `~/.gregmat-mcp/session.json` (mode 600) and refreshed automatically. |

The server tries them in this order:
1. `GREGMAT_TOKEN` / `GREGMAT_COOKIE`
2. The cached session (refreshed if needed, then validated against `/authentication/me/`)
3. Email/password login, trying the `{email,password}` body first and then `{username,password}`

Secrets are never logged.

### Other env vars

| Env var | Default |
|---|---|
| `GREGMAT_TEST_DATE` | `2026-11-21` |
| `GREGMAT_STUDY_PLAN` | `the-im-overwhelmed-study-plan` |
| `GREGMAT_MCP_HOME` | `~/.gregmat-mcp` (holds `session.json`, `log.json`) |
| `GREGMAT_API_BASE` | `https://gregmat-backend.herokuapp.com` |
| `GREGMAT_TIMEOUT_MS` | `20000` |
| `GREGMAT_DEBUG` | unset. Set to `1` for verbose logging on stderr |

See `.env.example`. Use your MCP client's `env` block to pass these. Don't commit a `.env` file.

## Client configuration

Use the absolute path to `dist/index.js`.

### Claude Desktop (`claude_desktop_config.json`)

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "gregmat": {
      "command": "node",
      "args": ["/abs/path/gregmat-mcp/dist/index.js"],
      "env": {
        "GREGMAT_TOKEN": "eyJ...",
        "GREGMAT_TEST_DATE": "2026-11-21"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gregmat": {
      "command": "node",
      "args": ["/abs/path/gregmat-mcp/dist/index.js"],
      "env": { "GREGMAT_EMAIL": "you@example.com", "GREGMAT_PASSWORD": "..." }
    }
  }
}
```

### Claude Code

```bash
claude mcp add gregmat -e GREGMAT_EMAIL=you@example.com -e GREGMAT_PASSWORD=... -- node /abs/path/gregmat-mcp/dist/index.js
# or with a token:
claude mcp add gregmat -e GREGMAT_TOKEN=eyJ... -- node /abs/path/gregmat-mcp/dist/index.js
```

Example prompts:
- "How many days until my GRE, and am I on pace with the study plan?"
- "What are my weakest quant topics?"
- "Log that I got the ratio drill 3 right in 4 minutes."

## Optional: Playwright fallback

`get_diagnostics` with `include_sectional_tests: true` loads `https://gregmat.com/practice/sectional-tests/` in headless Chromium with your token cookie and extracts the text. It's optional:

```bash
npm install playwright && npx playwright install chromium
```

If Playwright is missing, the tool returns a clear error with this install hint. Nothing else breaks.

## Troubleshooting

- **`auth_failed`**: no credentials reached the server. Check the `env` block in your client config, then restart the client. Run `GREGMAT_TOKEN=... npm run check`.
- **401 / token expired**: `piniaAccess` tokens expire (about 7 days). Copy a fresh one, or use email/password so the server can refresh the token itself. Delete `~/.gregmat-mcp/session.json` to force a fresh login.
- **Google/Apple-only account**: password login won't work. Use `GREGMAT_TOKEN`.
- **The client shows no tools or a JSON parse error**: stdout is reserved for the MCP protocol, and this server logs only to stderr. Make sure you're running `dist/index.js` and not `npm start`, because npm prints banners to stdout. Rebuild with `npm run build`.
- **Slow first call**: the backend runs on Heroku and may cold-start. Raise `GREGMAT_TIMEOUT_MS`.
- **Corrupt local log**: `list_local_log` reports the parse error. Fix or move `~/.gregmat-mcp/log.json`.

## Fixing guessed endpoints

All URLs, paths, login body variants, page URLs and selectors are in **`src/config.ts`**. Each unverified entry is marked `// GUESS:` and `verified: false`.

1. Run `GREGMAT_TOKEN=... npm run check`. It shows which auth path worked and which login body variant succeeded. For every endpoint it prints the HTTP status, top-level JSON keys and item counts. A wrong path or shape is flagged as `NEEDS UPDATE: src/config.ts <key>`.
2. Inspect the real shape from your assistant with `raw_get`, e.g. `raw_get {"path": "/ps/questions/", "query": {"limit": 5}}`. You can also open DevTools → Network on gregmat.com while browsing your progress pages and copy the request paths.
3. Fix the path or default query in `ENDPOINTS` and set `verified: true`.
4. If the path is right but fields aren't picked up (for example `per_user_status_detected: false`), add the real field names to the candidate key lists in `src/normalize.ts`. Examples are `normalizeQuestion` for solved/correct flags, `DONE_KEYS` for study plan units, and `normalizeQuiz` for scores.
5. To allow a new path through `raw_get`, add its prefix to `RAW_GET_ALLOWED_PREFIXES`. Never add write endpoints (`/solve/`, `/action/`, `/done/`, …). Those are explicitly denied.
6. `npm run build && npm test && npm run check`.

## Development

```
src/
  config.ts     base URLs, endpoints, login variants, pages, selectors (only place to edit guesses)
  auth.ts       token/cookie/session/login resolution, refresh, session cache (chmod 600)
  api.ts        GET-only fetch client: bearer, 401 → refresh once, timeouts, DRF pagination
  gregmat.ts    data access (never throws; returns {ok,data}|{ok:false,error})
  normalize.ts  defensive mappers raw JSON → normalized types, streak/date helpers
  localLog.ts   ~/.gregmat-mcp/log.json
  scraper.ts    optional Playwright fallback (lazy import)
  tools.ts      the 9 MCP tools
  selftest.ts   npm run check
  server.ts     McpServer factory
  index.ts      CLI: stdio server, --self-test, --help
test/smoke.mjs  npm test: stdio MCP client smoke test + offline unit tests with mocked fetch
```

`npm test` makes no network requests to GregMAT. The spawned server gets no credentials and a closed localhost API base. The unit tests use a mocked `fetch`.
