# gregmat-mcp

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Desktop, Claude Code, Cursor, …) read your [GregMAT](https://gregmat.com) GRE prep progress, plus a local study log for anything GregMAT doesn't track.

> GregMAT has no public API. The endpoints and response shapes used here were verified against a logged-in session (see `docs/API-FINDINGS.md`). Login needs a reCAPTCHA, so it happens in a real browser window (`--login`). If the site changes, `npm run check` flags what broke; see [When the site changes](#when-the-site-changes).

## What it does

| Tool | What it returns |
|---|---|
| `get_profile` | Name, email, subscription, ids (`/authentication/me/`) |
| `get_progress_summary` | Solved/attempted counts per section, category and topic (from your `/ps/questions/` attempts), quiz and skill-building stats, study-plan %, local log, last activity, streak, days until test |
| `list_completed_items` | Problems with attempts (correct = first attempt), quiz attempts, done study-plan units (`video`), skill-building drills (`skill`), merged with the local log. Args: `type`, `since`, `section`, `limit` |
| `get_quiz_results` | Attempts and scores for the GRE Mini Exams and timed Quant/Verbal sections. Args: `slug`, `group`, `taken_only` |
| `get_diagnostics` | **Derived** first-attempt accuracy by category, question type and topic (weakest first), plus untouched topics, quiz averages and skill-building accuracy |
| `get_study_plan_progress` | Units done/total across all modules of the parent plan, next undone units, units/day needed by test day. Arg: `slug` |
| `raw_get` | Debugging: GET an allowlisted API path and see the raw JSON |
| `log_solved_problem` | Append to the **local** log (`source`, `section`, `topic`, `item`, `correct`, `score`, `time_minutes`, `notes`, `date`) |
| `list_local_log` | Local log entries + stats. Args: `since`, `section`, `topic` |

`/ps/questions/` (about 920 questions, 5 pages per section of 200) is the main data source. Results are cached in memory for 5 minutes (`GREGMAT_CACHE_TTL_MS`); tools accept `refresh: true` to bypass the cache.

The server only sends GET requests to GregMAT. The only POST is the token refresh. It never marks anything done, submits answers, or changes your account. If a GregMAT call fails, the tool returns `{error, endpoint, status, hint}` and still includes local-log data where it's relevant. The server doesn't crash on these errors.

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

### Logging in

GregMAT's login endpoint requires a Google reCAPTCHA token, so a plain HTTP login is impossible. The server logs in through a real, **headed** Chrome window (Playwright) and captures the access and refresh tokens from the login response.

**Recommended: sign in once by hand.**

```bash
node dist/index.js --login
```

A browser window opens on gregmat.com; sign in however you like (email, Google, Apple). The window closes by itself, and the session is cached in `~/.gregmat-mcp/session.json` (mode 600). From then on the access token is refreshed automatically with the refresh token. You only need to repeat this if the refresh token expires.

**No display (headless Linux/SSH)?** Browser login needs a display; headless Chrome fails reCAPTCHA. Either run `--login` on a desktop and copy `session.json` over (keep mode 600), or use a virtual display: `xvfb-run -a node dist/index.js --login` (automatic mode below works the same way).

Playwright is an optional dependency (`npm install` pulls it in). System Chrome is used when available (`channel: 'chrome'`); set `GREGMAT_CHROME_PATH` to point at a specific Chrome/Chromium binary. Otherwise run `npx playwright install chromium`.

| Env var | Notes |
|---|---|
| `GREGMAT_TOKEN` | Access JWT: the value of the `piniaAccess` cookie on gregmat.com (about 7 days; no refresh). |
| `GREGMAT_COOKIE` | The whole `Cookie:` header from a logged-in gregmat.com request. `piniaAccess` is extracted. |
| `GREGMAT_EMAIL` + `GREGMAT_PASSWORD` | Automatic browser login when no valid session exists (needs a display). Not for Google/Apple-only accounts. Tokens are cached; the password is never stored. |
| `GREGMAT_CHROME_PATH` | Chrome/Chromium binary for browser login. |

Resolution order:
1. `GREGMAT_TOKEN` / `GREGMAT_COOKIE`
2. The cached session (`~/.gregmat-mcp/session.json`): used while the JWT `exp` is in the future, refreshed via `POST /authentication/auth/jwt/refresh/` when expired
3. Automatic browser login with `GREGMAT_EMAIL` / `GREGMAT_PASSWORD`

If nothing works, tools return `auth_failed` with a hint to run `--login`. Secrets are never logged.

### Other env vars

| Env var | Default |
|---|---|
| `GREGMAT_TEST_DATE` | `2026-11-21` |
| `GREGMAT_STUDY_PLAN` | `the-im-overwhelmed-study-plan` (parent plan slug) |
| `GREGMAT_MCP_HOME` | `~/.gregmat-mcp` (holds `session.json`, `log.json`) |
| `GREGMAT_API_BASE` | `https://gregmat-backend.herokuapp.com` |
| `GREGMAT_TIMEOUT_MS` | `20000` |
| `GREGMAT_CACHE_TTL_MS` | `300000` (`/ps/questions` cache) |
| `GREGMAT_CHROME_PATH` | unset |
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

## Troubleshooting

- **`auth_failed`**: no valid session. Run `node dist/index.js --login`, or set `GREGMAT_TOKEN`, then `npm run check`.
- **"No display available"**: browser login needs a display. Use `xvfb-run -a node dist/index.js --login`, or log in on a desktop and copy `~/.gregmat-mcp/session.json`.
- **Login returns HTTP 400 / reCAPTCHA**: use `--login` and sign in by hand; automatic mode can be rejected by reCAPTCHA. Delete `~/.gregmat-mcp/session.json` to force a fresh login.
- **401 / token expired**: with a cached session the server refreshes automatically. `GREGMAT_TOKEN` can't be refreshed; copy a new one or use `--login`.
- **The client shows no tools or a JSON parse error**: stdout is reserved for the MCP protocol, and this server logs only to stderr. Make sure you're running `dist/index.js` and not `npm start`, because npm prints banners to stdout. Rebuild with `npm run build`.
- **Slow first call**: the backend runs on Heroku and may cold-start. Raise `GREGMAT_TIMEOUT_MS`.
- **Corrupt local log**: `list_local_log` reports the parse error. Fix or move `~/.gregmat-mcp/log.json`.

## When the site changes

All URLs, paths, quiz sources, selectors and param names are in **`src/config.ts`**; every endpoint there is `verified: true` as of the live probe (`docs/API-FINDINGS.md`).

1. Run `npm run check`. It shows which auth path worked and, per endpoint, the HTTP status, top-level keys and item counts. A wrong path or shape is flagged as `NEEDS UPDATE: src/config.ts <key>`.
2. Inspect the real shape with `raw_get`, e.g. `raw_get {"path": "/ps/questions/", "query": {"limit": 5, "super_category": "Quant"}}`.
3. Fix `ENDPOINTS` / `QUIZ_SOURCES` in `src/config.ts`; field mappers are in `src/normalize.ts`.
4. Quiz `attempts` were empty when probed, so their element shape is mapped defensively (`normalizeQuizAttempt`: score / date key lists). Each attempt is returned with its `raw` object; if scores come back `null`, add the real key names there.
5. Never add write endpoints (`/solve/`, `/action/`, `/done/`, …) to `RAW_GET_ALLOWED_PREFIXES`; they are explicitly denied.
6. `npm run build && npm test && npm run check`.

## Development

```
src/
  config.ts     base URLs, endpoints, QUIZ_SOURCES, browser-login selectors (only place to edit)
  auth.ts       token/cookie/session/browser-login resolution, refresh, session cache (chmod 600)
  tokens.ts     JWT exp / cookie / token-extraction helpers
  browserLogin.ts  headed Playwright login capturing access+refresh from the login response
  login.ts      the --login CLI command
  api.ts        GET-only fetch client: bearer, 401 → refresh once, timeouts, DRF pagination
  gregmat.ts    data access (never throws; returns {ok,data}|{ok:false,error})
  normalize.ts  mappers raw JSON → normalized types, streak/date helpers
  analytics.ts  pure aggregations (first-attempt accuracy, weakest-first, untouched topics)
  localLog.ts   ~/.gregmat-mcp/log.json
  tools.ts      the 9 MCP tools
  selftest.ts   npm run check
  server.ts     McpServer factory
  index.ts      CLI: stdio server, --login, --self-test, --help
test/smoke.mjs  npm test: stdio MCP smoke test + offline tests against mocked backend shapes (no network, no real data)
```

`npm test` makes no network requests to GregMAT. The spawned server gets no credentials and a closed localhost API base. The unit tests use a mocked `fetch`.
