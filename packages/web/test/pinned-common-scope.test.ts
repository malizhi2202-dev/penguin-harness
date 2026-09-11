/**
 * The **pinned** common-scope store (state/project.tsx): `createProjectStore(true)` is the store
 * the System settings page's global sections read the common configuration scope through. It is
 * what keeps configuring common data from moving the rest of the app, so the invariants the
 * sidebar, the switcher and the sessions list depend on are pinned here:
 * - it is born on the reserved id, with no Project list to wait for and no read of the
 *   remembered selection (localStorage) — mounting it cannot change which Project the app is in;
 * - it cannot be re-pointed: `setCurrentProjectId` is a no-op, so no call under it can write the
 *   reserved id (or anything else) into the remembered selection or into the server-side prefs;
 * - its Agent list is the scope's own, keyed per scope like any other, and its current scope is
 *   synthesized (`commonScopeSummary`) rather than found in the Project list.
 *
 * The app's own store is the mirror image — created without the flag, it resolves a Project from
 * the list (see common-scope.test.ts) and reaches the reserved id never.
 *
 * Runs against the real store factory (zustand vanilla, no DOM) with localStorage and fetch
 * stubbed — draft-cache.test.ts's storage convention.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SCOPE_ID } from "../src/lib/common-scope";
import { PROJECT_KEY, createProjectStore } from "../src/state/project";

/** In-memory storage (vitest runs in a Node environment, no localStorage; draft-cache.test.ts convention). */
function memStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** The paths that reached fetch; the prefs write is the only call the store ever makes. */
let fetchCalls: string[];
/** The storage the store reads and writes this test. */
let storage: ReturnType<typeof memStorage>;

beforeEach(() => {
  fetchCalls = [];
  storage = memStorage();
  vi.stubGlobal("localStorage", storage);
  // Never resolves: a queued request must not decide anything, and an empty array must mean
  // "nothing was sent", not "something is still in flight".
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push(`${String(init?.method ?? "GET")} ${String(_input)}`);
    return new Promise<Response>(() => {});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A pinned store, as the settings page's global sections mount it. */
function pinnedStore() {
  return createProjectStore(true);
}

describe("createProjectStore (pinned to the common scope)", () => {
  it("is born on the reserved id, with no Project list to wait for", () => {
    const s = pinnedStore().getState();

    expect(s.currentProjectId).toBe(COMMON_SCOPE_ID);
    // The embedded pages never render a Project switcher, so nothing waits on a list that would
    // not contain this scope anyway.
    expect(s.projectsLoading).toBe(false);
    expect(s.projects).toEqual([]);
  });

  it("does not read the remembered selection when it loads", async () => {
    // A reader standing in proj-1 opens a global section: mounting the pinned store must not
    // touch what the app's own store remembers, or leaving settings would land elsewhere.
    storage.map.set(PROJECT_KEY, "proj-1");
    const store = pinnedStore();

    await store.getState().reloadProjects();

    expect(store.getState().currentProjectId).toBe(COMMON_SCOPE_ID);
    expect(storage.map.get(PROJECT_KEY)).toBe("proj-1");
    // No list read either: the reserved id is not a Project, and resolving it would only bounce
    // the store onto one.
    expect(fetchCalls).toEqual([]);
  });

  it("cannot be re-pointed: the selection and the prefs write stay untouched", () => {
    storage.map.set(PROJECT_KEY, "proj-1");
    const store = pinnedStore();

    store.getState().setCurrentProjectId("proj-2");

    expect(store.getState().currentProjectId).toBe(COMMON_SCOPE_ID);
    expect(storage.map.get(PROJECT_KEY)).toBe("proj-1");
    expect(fetchCalls).toEqual([]);
  });

  it("loads the scope's own Agents, remembering the picked one per scope", async () => {
    const store = pinnedStore();
    let agents: { agentId: string; name?: string }[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ agents }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await store.getState().reloadAgents();
    expect(fetchCalls[0]).toBe(`/api/projects/${COMMON_SCOPE_ID}/agents`);

    // The pick is remembered under the scope's own key, exactly as a Project's is under its own.
    store.getState().setCurrentAgentId("researcher");
    agents = [
      { agentId: "default_agent", name: "Default" },
      { agentId: "researcher", name: "Researcher" },
    ];
    store.setState({ currentAgentId: null, agents: [] });
    await store.getState().reloadAgents();

    expect(storage.map.get(`penguin.lastAgentId.${COMMON_SCOPE_ID}`)).toBe("researcher");
    expect(store.getState().currentAgentId).toBe("researcher");
  });

  it("leaves an unreadable scope empty rather than rejecting", async () => {
    const store = pinnedStore();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response("nope", { status: 500, headers: { "content-type": "text/plain" } }),
      ),
    );

    await expect(store.getState().reloadAgents()).resolves.toBeUndefined();
    expect(store.getState().agents).toEqual([]);
    expect(store.getState().currentAgentId).toBeNull();
    expect(store.getState().agentsLoading).toBe(false);
  });
});
