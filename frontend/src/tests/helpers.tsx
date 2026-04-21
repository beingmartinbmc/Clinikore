import { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render, RenderOptions } from "@testing-library/react";
import { vi } from "vitest";
import { I18nProvider } from "../i18n/I18nContext";
import { TourProvider } from "../tour/TourContext";

/** Test wrapper that installs every provider the app relies on. */
export function AllProviders({
  children,
  route = "/",
}: {
  children: ReactNode;
  route?: string;
}) {
  return (
    <I18nProvider>
      <MemoryRouter initialEntries={[route]}>
        <TourProvider>{children}</TourProvider>
      </MemoryRouter>
    </I18nProvider>
  );
}

/** Render helper that wraps every call with all the app providers. */
export function renderApp(
  ui: ReactElement,
  { route = "/", ...options }: { route?: string } & RenderOptions = {},
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders route={route}>{children}</AllProviders>
    ),
    ...options,
  });
}

/**
 * Fetch mock that routes requests to a canned response map. Each entry can be
 * a plain value (returned as JSON with status 200) or a full {status, body,
 * contentType} descriptor. The key matches either the exact URL or a
 * `${method} ${path}` string.
 */
type FetchHandler =
  | ((init: RequestInit | undefined, url: string) => Response | Promise<Response>)
  | unknown;

export interface InstallFetchOptions {
  /** Map of "<METHOD> <path>" or "<path>" -> handler / value. */
  routes?: Record<string, FetchHandler>;
  /** Default JSON response for unmatched GETs. */
  fallback?: unknown;
}

export function installFetchMock({ routes = {}, fallback = [] }: InstallFetchOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({ url, init });
    const method = (init?.method || "GET").toUpperCase();

    const key =
      routes[`${method} ${url}`] ??
      routes[url] ??
      routes[`${method} ${stripQuery(url)}`] ??
      routes[stripQuery(url)];

    if (key !== undefined) {
      const value = typeof key === "function" ? await (key as any)(init, url) : key;
      if (value instanceof Response) return value;
      return jsonResponse(value);
    }

    // 204 on DELETE by default so callers don't have to register every URL.
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(fallback);
  });

  (globalThis as any).fetch = fetchImpl as any;
  return { fetchImpl, calls };
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

export function errorResponse(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
