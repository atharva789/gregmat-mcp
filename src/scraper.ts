/**
 * Optional Playwright fallback. `playwright` is an optionalDependency and is
 * imported lazily; if it (or its browser) is missing we return a clear error.
 * Read-only: loads pages and extracts text; never clicks/submits.
 */
import { AUTH, PAGES, SELECTORS } from "./config.js";
import { log } from "./log.js";

export interface ScrapeResult {
  url: string;
  title: string | null;
  rows: string[];
  text: string;
}

export class ScraperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScraperUnavailableError";
  }
}

const INSTALL_HINT =
  "Playwright fallback is optional. Install with `npm install playwright && npx playwright install chromium` in the gregmat-mcp directory.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPlaywright(): Promise<any> {
  const name = "playwright";
  try {
    return await import(name);
  } catch {
    throw new ScraperUnavailableError(`playwright is not installed. ${INSTALL_HINT}`);
  }
}

export async function scrapePage(
  url: string,
  token: string,
  rowSelector: string = SELECTORS.sectionalTestRow.css,
  opts: { timeoutMs?: number; maxRows?: number } = {},
): Promise<ScrapeResult> {
  const pw = await loadPlaywright();
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    throw new ScraperUnavailableError(`could not launch Chromium (${(e as Error).message.split("\n")[0]}). ${INSTALL_HINT}`);
  }
  try {
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: AUTH.cookieName,
        value: token,
        domain: AUTH.cookieDomain,
        path: "/",
        secure: true,
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + AUTH.cookieMaxAgeSeconds,
      },
    ]);
    const page = await context.newPage();
    log.debug(`scraping ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs ?? 45000 });
    const title: string | null = await page.title().catch(() => null);
    const rows: string[] = await page
      .locator(rowSelector)
      .allInnerTexts()
      .catch(() => [] as string[]);
    const main = page.locator(SELECTORS.pageMain.css).first();
    const text: string = await main.innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText());
    return {
      url,
      title,
      rows: rows.map((r) => r.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, opts.maxRows ?? 200),
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, 20000),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function scrapeSectionalTests(token: string): Promise<ScrapeResult> {
  return scrapePage(PAGES.sectionalTests.url, token, SELECTORS.sectionalTestRow.css);
}
