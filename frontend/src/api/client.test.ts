import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiBlob, apiFetch, setActiveWorkspaceId } from "./client";

describe("API transport", () => {
  beforeEach(() => setActiveWorkspaceId(null));

  it("adds mutation and tenant headers without exposing session handling to callers", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    setActiveWorkspaceId("workspace-1");

    await apiFetch("/api/example", {
      method: "POST",
      body: JSON.stringify({ value: 1 }),
    });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Workspace-Id")).toBe("workspace-1");
    expect(headers.get("X-Requested-With")).toBe("seo-indexer-ui");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init?.credentials).toBe("include");
  });

  it("turns structured API failures into errors with status and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "No access" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(apiFetch("/api/example")).rejects.toMatchObject({
      message: "No access",
      status: 403,
      body: { error: "No access" },
    });
  });

  it("downloads files with the active workspace and session", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return new Response("name,value\nExample,1");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    setActiveWorkspaceId("workspace-2");

    const blob = await apiBlob("/api/platform/metrics/export.csv");
    expect(blob.size).toBeGreaterThan(0);
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("X-Workspace-Id")).toBe(
      "workspace-2",
    );
    expect(init?.credentials).toBe("include");
  });
});
