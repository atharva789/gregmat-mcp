# gregmat-mcp — Specification

Local MCP server that lets an AI assistant read the user's GregMAT (gregmat.com) GRE prep progress, plus a local log fallback. Target: user's GRE on 2026-11-21.

## Platform
- TypeScript, Node >= 18, ESM, official `@modelcontextprotocol/sdk`, stdio transport. `zod` for tool schemas.
- Install: `git clone … && npm install && npm run build`; run `node dist/index.js` or `npx gregmat-mcp` (package.json `bin`).
- Scripts: `build` (tsc), `start`, `check` (= `node dist/index.js --self-test`), `test` (stdio smoke test listing tools, no credentials needed).
- README: setup, login, env vars, config snippets for Claude Desktop, Cursor and Claude Code, troubleshooting, and a "When the site changes" section.

## What we know about GregMAT (verified with a logged-in probe; see docs/API-FINDINGS.md)
- Frontend: Nuxt 3 SPA at https://gregmat.com using @sidebase/nuxt-auth. API base `https://gregmat-backend.herokuapp.com` (Django REST, trailing slashes). Header `Authorization: Bearer <access>`.
- **Auth.** `POST authentication/sidebaseMultiplexedLogin/` takes `{email, password, recaptcha, vthree, platform}`; without a valid Google reCAPTCHA token it returns 400, and headless Chrome fails reCAPTCHA too, so **pure-HTTP login is impossible**. Login is therefore **browser-based**: a headed Chrome (Playwright; `channel: 'chrome'`, `GREGMAT_CHROME_PATH`, `--disable-blink-features=AutomationControlled`) on gregmat.com, click "Log in", fill `input[type=email]`/`input[type=password]`, Enter. The login response is 200 `{refresh, access}`; both tokens are captured from that network response (the `piniaAccess` cookie holds only the access token). A `--login` CLI lets the user sign in manually (Google/Apple). Refresh: `POST authentication/auth/jwt/refresh/ {refresh}`; on failure fall back to browser login.
- Verified GET endpoints: `/authentication/me/`, `/ps/stats/` (site totals), `/ps/question-counts/?super_category=Quant|Verbal` (required; codes are `Quant`/`Verbal`), `/ps/question-tags/`, `/ps/questions/?limit=200&offset=N&super_category=…` (per-user `status`, `user_answer_attempts`, `first_tlc`, `tags`), `/ps/quizgroup/gre-mini-exams/`, `/ps/quizsupergroup/timed-gre-{quant,verbal}-sections/`, `/sb/stats/me/`, `/studyplans/?limit=100`, `/studyplans/{slug}/`, `/classes/upcoming/`.
- Broken guesses (do not use): `/quizzes/collection/`, `/quizzes/quiz-group/`, `/quizzes/quiz/` (404), `/ps/quiz/{slug}/` (404), `/practice/sectional-tests/` (page 404; "sectional tests" are the timed-sections supergroups). Never call `POST /studyplans/done/{id}/` (read-only server).
- No diagnostics endpoint: diagnostics are DERIVED from first-attempt correctness in `/ps/questions/` grouped by `first_tlc`, `type` and topic tag, plus quiz and `/sb/stats/me/` data.
- Study plans: parent plans have `flags.planRole = 'plan'` and empty `units`; their modules have `flags.parentSlug` and `moduleIndex`. Progress = done units across all modules of the parent.

## Architecture
- `src/config.ts` — THE ONLY place for base URLs, endpoint paths, `QUIZ_SOURCES`, browser-login selectors and param names. Each endpoint carries a `verified` flag.
- `src/auth.ts` / `src/tokens.ts` / `src/browserLogin.ts` / `src/login.ts` — resolves auth in order: `GREGMAT_TOKEN` / `GREGMAT_COOKIE` → cached session `~/.gregmat-mcp/session.json` (access + refresh, chmod 600, JWT `exp` check, refresh via refresh token) → automatic browser login with `GREGMAT_EMAIL`/`GREGMAT_PASSWORD`. `--login` runs the browser in manual mode. Without a display on Linux, fail with a clear error suggesting `xvfb-run` or `--login` on a desktop. Never log secrets; never store the password.
- `src/api.ts` — fetch client (base URL, bearer, one retry on 401 after refresh, timeouts, pagination helper).
- `src/gregmat.ts` — data access; `/ps/questions/` for both super categories cached in memory ~5 minutes.
- `src/normalize.ts`, `src/analytics.ts` — mappers and pure aggregations (first-attempt accuracy, weakest-first, untouched topics).
- `src/localLog.ts` — JSON file `~/.gregmat-mcp/log.json` (override `GREGMAT_MCP_HOME`).
- `src/tools.ts`, `src/index.ts` (CLI: default stdio server; `--login`; `--self-test`; `--help`).
- Logs to stderr only (stdout is MCP protocol).

## Tools (all read-only against GregMAT)
1. `get_profile` — `/authentication/me/` (name, email, subscription, ids).
2. `get_progress_summary` — solved/attempted counts per section/category/topic from `/ps/questions/`, quiz and `/sb/stats/me/` stats, study plan across modules, local log; last activity and streak from `answered_at` dates; days until test (2026-11-21, overridable `GREGMAT_TEST_DATE`).
3. `list_completed_items` — args: `type?` (problem|quiz|video|skill|all), `since?`, `limit?`. Problems with attempts from `/ps/questions/` (correct = first attempt), quiz attempts from `QUIZ_SOURCES`, done study-plan units, skill-building drills; merges local log.
4. `get_quiz_results` — args `slug?`, `group?`, `taken_only?`: scores/attempts per quiz from `QUIZ_SOURCES`.
5. `get_diagnostics` — first-attempt accuracy by `first_tlc`, type and topic tag (weakest first), untouched topics (incl. `/ps/question-counts/` tags); documents that it is derived.
6. `get_study_plan_progress` — args `slug?` (default env `GREGMAT_STUDY_PLAN` or `the-im-overwhelmed-study-plan`): units done/total across all modules of the parent plan, plan-in-use detection, next N undone units, per-day pacing to test date.
7. `raw_get` — args `path` (must start with an allowlisted prefix from config; GET only) for debugging/learning response shapes.
8. `log_solved_problem` — args: `source` (default "gregmat"), `section` (quant|verbal|awa), `topic`, `item` (name/slug), `correct?`, `score?`, `time_minutes?`, `notes?`, `date?`.
9. `list_local_log` — args `since?`, `section?`, `topic?`; returns entries + aggregate stats.

Each GregMAT tool: on endpoint failure return structured error `{error, endpoint, status, hint:"edit src/config.ts"}` and still include local-log data where relevant (never crash server).

## Self-test (`npm run check`)
Authenticates, reports which auth path worked, hits each configured (verified) endpoint printing status + top-level JSON keys + item counts, flags endpoints returning 404/shape mismatch as "NEEDS UPDATE: src/config.ts <key>", prints a progress summary. Exit non-zero if auth fails.

## Security
- `.gitignore`: node_modules, dist, .env*, *.session.json, ~/.gregmat-mcp never in repo. `.env.example` with blank values.
- No write calls to GregMAT besides token refresh (login happens in the browser).

## Acceptance
- `npm install && npm run build` passes with no TS errors.
- `npm test` spawns the server over stdio with an MCP client (SDK Client + StdioClientTransport), lists all 9 tools, calls `log_solved_problem` + `list_local_log` against a temp `GREGMAT_MCP_HOME`, and calls `get_profile` without creds expecting a clean structured auth error. Further tests run every tool against a mocked backend that follows the verified response shapes (no network, no real personal data) and cover session cache, JWT expiry, refresh and the no-display error.
