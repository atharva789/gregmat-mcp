# gregmat-mcp — Specification

Local MCP server that lets an AI assistant read the user's GregMAT (gregmat.com) GRE prep progress, plus a local log fallback. Target: user's GRE on 2026-11-21.

## Platform
- TypeScript, Node >= 18, ESM, official `@modelcontextprotocol/sdk`, stdio transport. `zod` for tool schemas.
- Install: `git clone … && npm install && npm run build`; run `node dist/index.js` or `npx gregmat-mcp` (package.json `bin`).
- Scripts: `build` (tsc), `start`, `check` (= `node dist/index.js --self-test`), `test` (stdio smoke test listing tools, no credentials needed).
- README: setup, env vars, config snippets for Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`), Claude Code (`claude mcp add gregmat -e GREGMAT_EMAIL=… -- node /abs/path/dist/index.js`), troubleshooting, and a "Fixing guessed endpoints" section.

## What we know about GregMAT (from public JS bundles, not logged in)
- Frontend: Nuxt 3 SPA at https://gregmat.com using @sidebase/nuxt-auth, provider "local".
- API base: `https://gregmat-backend.herokuapp.com` (Django REST style, trailing slashes).
- Auth (CONFIRMED from config): sign-in `POST authentication/sidebaseMultiplexedLogin/` → JSON with `access` (JWT) and `refresh`. Session: `GET authentication/me/`. Refresh: `POST authentication/auth/jwt/refresh/` with `{refresh}` (refreshOnlyToken). Header `Authorization: Bearer <access>`. Browser cookie `piniaAccess` holds the access token (domain gregmat.com), max age 7 days. Sign-in also supports Google / Apple.
- GUESS: sign-in request body shape. Try `{email, password}` first, then `{username: email, password}`; report which worked.
- Endpoints seen in bundles (response shapes UNKNOWN — GUESSES):
  - `GET /ps/stats/` (problem-solving stats; "getProblemsCount")
  - `GET /ps/questions/?limit=&offset=&ordering=&include_unlisted=` (paginated, `results` field; likely includes per-user solved status)
  - `GET /ps/question-counts/`, `GET /ps/question-tags/`
  - `GET /ps/quizgroup/{slug}/`, `/ps/quizsupergroup/{slug}/`, `/ps/quiz/{slug}/`, `/quizzes/collection/`, `/quizzes/quiz-group/`, `/quizzes/quiz/`
  - `GET /sb/stats/me/` (skill-building stats), `GET /sb/pertype/{type}/`
  - `GET studyplans/{slug}/` (study plan units with done flags); `POST /studyplans/done/{id}/ {done}` (DO NOT CALL — read-only server). Known slug: `the-im-overwhelmed-study-plan`.
  - `GET /classes/upcoming/`, `/content/content/{id}/`
  - Full observed list in `docs-endpoints-observed.txt`.
- No dedicated "diagnostic" endpoint found; diagnostics must be DERIVED from per-question/quiz results grouped by tag/section (Quant/Verbal), plus sectional-test pages (`/practice/sectional-tests/`) if available.

## Architecture
- `src/config.ts` — THE ONLY place for base URLs, endpoint paths, login body variants, page URLs and Playwright selectors. Every unverified item has `// GUESS:` comment and a `verified: false` flag.
- `src/auth.ts` — resolves auth in order: `GREGMAT_TOKEN` (raw access JWT) / `GREGMAT_COOKIE` (cookie header string; extract `piniaAccess`) → cached session `~/.gregmat-mcp/session.json` (chmod 600, refresh via refresh token, check via `/authentication/me/`) → `GREGMAT_EMAIL`/`GREGMAT_PASSWORD` login. Never log secrets.
- `src/api.ts` — fetch client (base URL, bearer, auto-refresh on 401 once, timeouts, pagination helper), raw JSON returned when shape unknown.
- `src/scraper.ts` — optional Playwright fallback (`playwright` as optionalDependency, lazy import); injects token cookie, loads pages, extracts text via selectors from config. If Playwright missing, return clear error with install hint.
- `src/normalize.ts` — defensive mappers from raw JSON to normalized types; unknown shapes pass through as `raw` so the assistant can still read them.
- `src/localLog.ts` — JSON file `~/.gregmat-mcp/log.json` (override `GREGMAT_MCP_HOME`).
- `src/tools.ts`, `src/index.ts` (CLI: default stdio server; `--self-test`; `--help`).
- Logs to stderr only (stdout is MCP protocol).

## Tools (all read-only against GregMAT)
1. `get_profile` — `/authentication/me/` (name, email, subscription, ids).
2. `get_progress_summary` — combine `/ps/stats/`, `/sb/stats/me/`, study plan, local log: counts by section/topic, last activity, streak (from dated activity incl. local log), days until test (2026-11-21, overridable `GREGMAT_TEST_DATE`).
3. `list_completed_items` — args: `type?` (problem|quiz|video|skill|all), `since?`, `limit?`. Solved problems from `/ps/questions/` (filter solved/attempted), quiz attempts, study plan units done; merges local log.
4. `get_quiz_results` — args `slug?`, `group?`: scores/attempts per quiz.
5. `get_diagnostics` — accuracy by tag/topic and Quant vs Verbal, weakest N topics, unattempted high-yield topics; documents that it is derived.
6. `get_study_plan_progress` — args `slug?` (default env `GREGMAT_STUDY_PLAN` or `the-im-overwhelmed-study-plan`): units done/total, next N undone units, per-day pacing to test date.
7. `raw_get` — args `path` (must start with an allowlisted prefix from config; GET only) for debugging/learning response shapes.
8. `log_solved_problem` — args: `source` (default "gregmat"), `section` (quant|verbal|awa), `topic`, `item` (name/slug), `correct?`, `score?`, `time_minutes?`, `notes?`, `date?`.
9. `list_local_log` — args `since?`, `section?`, `topic?`; returns entries + aggregate stats.

Each GregMAT tool: on endpoint failure return structured error `{error, endpoint, status, hint:"edit src/config.ts"}` and still include local-log data where relevant (never crash server).

## Self-test (`npm run check`)
Authenticates, reports which auth path / login body variant worked, hits each configured endpoint printing status + top-level JSON keys + item counts, flags endpoints returning 404/shape mismatch as "NEEDS UPDATE: src/config.ts <key>", prints a progress summary. Exit non-zero if auth fails.

## Security
- `.gitignore`: node_modules, dist, .env*, *.session.json, ~/.gregmat-mcp never in repo. `.env.example` with blank values.
- No write calls to GregMAT besides login/refresh.

## Acceptance
- `npm install && npm run build` passes with no TS errors.
- `npm test` spawns the server over stdio with an MCP client (SDK Client + StdioClientTransport), lists all 9 tools, calls `log_solved_problem` + `list_local_log` against a temp `GREGMAT_MCP_HOME`, and calls `get_profile` without creds expecting a clean structured auth error.
