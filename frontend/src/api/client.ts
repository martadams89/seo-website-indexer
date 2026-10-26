const BASE = import.meta.env.VITE_API_URL ?? "";
const WORKSPACE_STORAGE_KEY = "active-workspace-id";

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/**
 * The workspace this tab is showing comes from its URL (/w/<slug>/…), so links
 * open in the right workspace and two tabs can show different ones.
 * localStorage only remembers the last one used, for URLs without a workspace.
 */
const URL_MATCH = typeof window !== "undefined" ? /^\/w\/([^/]+)/.exec(window.location.pathname) : null;
/** The workspace slug (or id) in this tab's URL, if any. */
export const URL_WORKSPACE: string | null = URL_MATCH ? decodeURIComponent(URL_MATCH[1]) : null;
/** The router's basename: every in-app path lives under the URL's workspace. */
export const ROUTER_BASENAME: string | undefined = URL_MATCH ? URL_MATCH[0] : undefined;

/** A path inside the app for a workspace, e.g. workspacePath('acme', '/reviews') → '/w/acme/reviews'. */
export function workspacePath(slug: string, path = "/"): string {
  return `/w/${encodeURIComponent(slug)}${path.startsWith("/") ? path : `/${path}`}`;
}

// In memory per tab: another tab switching workspace never changes this one.
let activeWorkspaceId: string | null =
  typeof localStorage !== "undefined"
    ? localStorage.getItem(WORKSPACE_STORAGE_KEY)
    : null;

export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

export function setActiveWorkspaceId(id: string | null): void {
  activeWorkspaceId = id;
  try {
    if (id) localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
    else localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory header still works.
  }
}

export interface ApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

async function throwApiError(response: Response): Promise<never> {
  const body = (await response
    .json()
    .catch(() => ({ error: `HTTP ${response.status}` }))) as Record<
    string,
    unknown
  >;
  const error = new Error(
    (body.error as string) ?? `HTTP ${response.status}`,
  ) as ApiError;
  error.status = response.status;
  error.body = body;
  throw error;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set("Content-Type", "application/json");

  const method = (options?.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method))
    headers.set("X-Requested-With", "seo-indexer-ui");
  if (activeWorkspaceId) headers.set("X-Workspace-Id", activeWorkspaceId);

  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    // Also supports an explicitly allowed same-site API origin (for example a
    // separate app subdomain) while remaining harmless for same-origin builds.
    credentials: "include",
  });
  if (!response.ok) return throwApiError(response);

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Fetch an authenticated, tenant-scoped file without bypassing API headers. */
export async function apiBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  if (activeWorkspaceId) headers.set("X-Workspace-Id", activeWorkspaceId);
  const response = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
  });
  if (!response.ok) return throwApiError(response);
  return response.blob();
}
