/**
 * Browser-based login. GregMAT's login endpoint requires a Google reCAPTCHA
 * token, so we drive a real HEADED Chrome via Playwright and capture the
 * {access, refresh} tokens from the login network response.
 *
 *  - auto mode:   fills GREGMAT_EMAIL / GREGMAT_PASSWORD on the site.
 *  - manual mode: opens the site and waits while the user signs in (Google/Apple ok).
 * `playwright` is an optionalDependency, imported lazily. Secrets are never logged.
 */
import { API_BASE, AUTH, BROWSER_LOGIN, chromePath } from "./config.js";
import { AuthError } from "./errors.js";
import { log } from "./log.js";
import { cleanToken, extractTokens } from "./tokens.js";

export interface BrowserTokens {
  access: string;
  refresh?: string;
}

export interface BrowserLoginOptions {
  manual?: boolean;
  email?: string;
  password?: string;
  timeoutMs?: number;
}

/** A function that obtains tokens interactively; injectable so tests never open a browser. */
export type BrowserLoginFn = (opts: BrowserLoginOptions) => Promise<BrowserTokens>;

export const NO_DISPLAY_HINT =
  "Browser login needs a display (GregMAT's reCAPTCHA rejects headless browsers). On a headless Linux box run it under a virtual display, " +
  "e.g. `xvfb-run -a node dist/index.js --login` (auto mode needs GREGMAT_EMAIL/GREGMAT_PASSWORD), " +
  "or run `node dist/index.js --login` once on a desktop machine and copy ~/.gregmat-mcp/session.json over (keep mode 600).";

/** Throws a clear AuthError when no display is available (Linux only). */
export function assertDisplay(platform: string = process.platform, e: NodeJS.ProcessEnv = process.env): void {
  if (platform === "linux" && !e.DISPLAY && !e.WAYLAND_DISPLAY) {
    throw new AuthError(`No display available for browser login. ${NO_DISPLAY_HINT}`, ["browser login: no DISPLAY/WAYLAND_DISPLAY"]);
  }
}

const PW_HINT = "Install with `npm install playwright` (system Chrome is used if present; otherwise also run `npx playwright install chromium`).";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPlaywright(): Promise<any> {
  const name = "playwright";
  try {
    return await import(name);
  } catch {
    throw new AuthError(`Browser login needs the optional dependency "playwright", which is not installed. ${PW_HINT}`, ["playwright: not installed"]);
  }
}

/** Launch order: GREGMAT_CHROME_PATH → system Chrome (channel 'chrome') → Playwright's Chromium. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function launch(pw: any): Promise<any> {
  const base = { headless: false, args: [...BROWSER_LOGIN.launchArgs] };
  const errors: string[] = [];
  const exe = chromePath();
  const attempts: [string, Record<string, unknown>][] = [];
  if (exe) attempts.push([`GREGMAT_CHROME_PATH`, { ...base, executablePath: exe }]);
  attempts.push(["system Chrome", { ...base, channel: "chrome" }], ["bundled Chromium", base]);
  for (const [label, opts] of attempts) {
    try {
      return await pw.chromium.launch(opts);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new AuthError(`Could not launch a browser. ${errors.join("; ")}. Set GREGMAT_CHROME_PATH to a Chrome binary or ${PW_HINT}`, errors);
}

export const defaultBrowserLogin: BrowserLoginFn = async (opts) => {
  assertDisplay();
  const manual = !!opts.manual;
  if (!manual && !(opts.email && opts.password)) {
    throw new AuthError("Automatic browser login needs GREGMAT_EMAIL and GREGMAT_PASSWORD (or use `--login` to sign in manually).");
  }
  const timeoutMs = opts.timeoutMs ?? (manual ? BROWSER_LOGIN.manualTimeoutMs : BROWSER_LOGIN.autoTimeoutMs);
  const pw = await loadPlaywright();
  const browser = await launch(pw);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    let resolveTokens!: (t: BrowserTokens) => void;
    let rejectTokens!: (e: Error) => void;
    const tokens = new Promise<BrowserTokens>((res, rej) => {
      resolveTokens = res;
      rejectTokens = rej;
    });
    tokens.catch(() => undefined);
    let lastStatus: number | null = null;

    // Capture BOTH tokens from the login network response (more reliable than the cookie).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on("response", async (res: any) => {
      try {
        const url = new URL(res.url());
        if (url.origin !== new URL(API_BASE).origin || res.request().method() !== "POST") return;
        const isLogin = url.pathname === AUTH.loginPath.path;
        if (isLogin) lastStatus = res.status();
        if (res.status() !== 200) return;
        // Manual mode also accepts other token-bearing POST responses (e.g. Google/Apple sign-in).
        if (!isLogin && !manual) return;
        const { access, refresh } = extractTokens(await res.json());
        if (access && !url.pathname.includes("refresh")) resolveTokens({ access, refresh });
      } catch {
        /* non-JSON or already closed */
      }
    });

    await page.goto(BROWSER_LOGIN.startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // The SPA hydrates after DOMContentLoaded; the login button only works once it is interactive.
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

    if (manual) {
      process.stderr.write("[gregmat-mcp] A browser window opened. Log in to GregMAT there (Google/Apple/email); this window closes by itself.\n");
      // Cookie fallback: the access token is also stored in the piniaAccess cookie.
      const poll = setInterval(async () => {
        try {
          const c = (await context.cookies()).find((x: { name: string }) => x.name === AUTH.cookieName);
          if (c?.value) {
            // Give the network listener a moment to win (it carries the refresh token too).
            setTimeout(() => resolveTokens({ access: cleanToken(c.value) }), 3000);
            clearInterval(poll);
          }
        } catch {
          clearInterval(poll);
        }
      }, 1500);
      tokens.finally(() => clearInterval(poll)).catch(() => undefined);
    } else {
      try {
        let opened = false;
        for (const text of BROWSER_LOGIN.openLoginTexts) {
          const el = page.getByText(new RegExp(`^\\s*${text}\\s*$`, "i")).first();
          if (await el.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false)) {
            await el.click();
            opened = true;
            break;
          }
        }
        if (!opened) log.debug("login button not found; assuming the form is already visible");
        await page.waitForTimeout(1500);
        await page.fill(BROWSER_LOGIN.emailSelector, opts.email!, { timeout: 15_000 });
        await page.fill(BROWSER_LOGIN.passwordSelector, opts.password!, { timeout: 15_000 });
        await page.press(BROWSER_LOGIN.passwordSelector, "Enter");
      } catch (e) {
        rejectTokens(new AuthError(`Browser login could not drive the login form: ${(e as Error).message.split("\n")[0]}. Use \`--login\` to sign in manually.`));
      }
    }

    const timer = setTimeout(
      () =>
        rejectTokens(
          new AuthError(
            lastStatus === 400
              ? "GregMAT rejected the login (HTTP 400, likely reCAPTCHA). Retry, or use `--login` and sign in by hand."
              : lastStatus
                ? `GregMAT login returned HTTP ${lastStatus} (wrong email/password?).`
                : `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a login response.`,
          ),
        ),
      timeoutMs,
    );
    try {
      return await tokens;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
};
