/** Read-only fetch client for the GregMAT backend. GET only. */
import { API_BASE, ENDPOINTS, EndpointKey, REQUEST_TIMEOUT_MS, USER_AGENT } from "./config.js";
import { AuthManager } from "./auth.js";
import { ApiError } from "./errors.js";
import { log } from "./log.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  url: string;
  path: string;
}

export interface PaginateOptions {
  maxPages?: number;
  maxItems?: number;
  pageSize?: number;
}

export interface PaginatedResult {
  items: unknown[];
  total: number | null;
  pagesFetched: number;
  truncated: boolean;
  /** First page as returned, for shape debugging. */
  firstPageKeys: string[];
}

/** Fill `{name}` placeholders in an endpoint path. */
export function fillPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || String(v) === "") throw new Error(`missing path param "${name}" for ${template}`);
    return encodeURIComponent(String(v));
  });
}

export function endpointPath(key: EndpointKey, params?: Record<string, string | number>): string {
  return fillPath(ENDPOINTS[key].path, params);
}

function buildUrl(path: string, query?: Query): URL {
  const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(API_BASE + (path.startsWith("/") ? path : `/${path}`));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

export class GregmatClient {
  constructor(
    public auth: AuthManager = new AuthManager(),
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T = unknown>(path: string, query?: Query): Promise<ApiResponse<T>> {
    const url = buildUrl(path, query);
    if (url.origin !== new URL(API_BASE).origin) {
      throw new ApiError(`refusing to call non-GregMAT origin ${url.origin}`, path, null);
    }
    let token = await this.auth.getToken();
    let res = await this.doFetch(url, token, path);
    if (res.status === 401) {
      const fresh = await this.auth.handleUnauthorized();
      if (fresh) {
        token = fresh;
        res = await this.doFetch(url, token, path);
      }
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body; keep text */
    }
    if (!res.ok) {
      const detail =
        data && typeof data === "object" && "detail" in (data as object)
          ? `: ${String((data as Record<string, unknown>).detail)}`
          : "";
      throw new ApiError(`HTTP ${res.status} for GET ${url.pathname}${detail}`, url.pathname, res.status, truncate(data));
    }
    if (typeof data === "string" && /^\s*</.test(data)) {
      throw new ApiError(`GET ${url.pathname} returned HTML, not JSON (wrong path?)`, url.pathname, res.status);
    }
    return { data: data as T, status: res.status, url: url.toString(), path: url.pathname };
  }

  getEndpoint<T = unknown>(key: EndpointKey, params?: Record<string, string | number>, query?: Query): Promise<ApiResponse<T>> {
    const def = ENDPOINTS[key] as { query?: Query };
    return this.get<T>(endpointPath(key, params), { ...(def.query ?? {}), ...(query ?? {}) });
  }

  /** Walk a DRF-style paginated list (`results` + `next`/`count`) or return a plain array. */
  async paginate(path: string, query: Query = {}, opts: PaginateOptions = {}): Promise<PaginatedResult> {
    const maxPages = opts.maxPages ?? 20;
    const maxItems = opts.maxItems ?? 2000;
    const pageSize = Number(opts.pageSize ?? query.limit ?? 100);
    const items: unknown[] = [];
    let total: number | null = null;
    let pages = 0;
    let firstPageKeys: string[] = [];
    let nextUrl: string | null = null;
    let offset = Number(query.offset ?? 0);

    while (pages < maxPages && items.length < maxItems) {
      const res: ApiResponse = nextUrl
        ? await this.get(nextUrl)
        : await this.get(path, { ...query, limit: pageSize, offset });
      pages++;
      const d = res.data;
      if (pages === 1) firstPageKeys = d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d) : [];
      if (Array.isArray(d)) {
        items.push(...d);
        total = d.length;
        break;
      }
      if (!d || typeof d !== "object") break;
      const obj = d as Record<string, unknown>;
      const page = Array.isArray(obj.results) ? obj.results : Array.isArray(obj.data) ? obj.data : Array.isArray(obj.items) ? obj.items : null;
      if (!page) {
        items.push(obj);
        break;
      }
      items.push(...page);
      if (typeof obj.count === "number") total = obj.count;
      if (page.length === 0) break;
      if (obj.next === undefined && page.length < pageSize) break;
      if (typeof obj.next === "string" && obj.next) {
        try {
          const n = new URL(obj.next, API_BASE);
          nextUrl = n.origin === new URL(API_BASE).origin ? n.toString() : null;
        } catch {
          nextUrl = null;
        }
        if (!nextUrl) {
          offset += page.length;
        }
      } else if (obj.next === null || (total !== null && offset + page.length >= total)) {
        break;
      } else {
        offset += page.length;
      }
    }
    const truncated = items.length >= maxItems || (total !== null && items.length < total);
    return { items: items.slice(0, maxItems), total, pagesFetched: pages, truncated, firstPageKeys };
  }

  private async doFetch(url: URL, token: string, path: string): Promise<Response> {
    log.debug(`GET ${url.pathname}${url.search}`);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      const err = e as Error;
      const reason = err.name === "TimeoutError" ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message;
      throw new ApiError(`network error for GET ${url.pathname}: ${reason}`, path, null);
    }
  }
}

function truncate(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, 500);
  try {
    const s = JSON.stringify(v);
    return s.length > 1000 ? s.slice(0, 1000) + "…" : v;
  } catch {
    return undefined;
  }
}
