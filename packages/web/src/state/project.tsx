/**
 * Current Project / Agent context:
 * - Project list (owned + authorized); the current selection is remembered in localStorage and
 *   synced to server-side prefs (lastProjectId, best-effort);
 * - the current scope's Agent list and current Agent (switched via the top-bar breadcrumb
 *   dropdown; remembered per scope). In the common scope those Agents are the templates a
 *   Project's create dialog copies from.
 *
 * The app's own Provider always stands in a Project. The System settings page's global sections
 * read the common scope's data through a **second, pinned Provider** of their own (mount one with
 * `pinnedCommon`): that store is born on the reserved id, never reads or writes the remembered
 * Project, and never re-points — so a reader configuring common data cannot change what the rest
 * of the app — sidebar, switcher, conversations — is showing, and leaving those sections needs no
 * restoring. The common scope therefore has exactly one surface, and it is inside settings.
 *
 * State lives in a zustand vanilla store (one instance per Provider mount, so an unmount
 * still resets everything); the Provider is a thin lifecycle component that triggers the
 * initial fetches and republishes the store's state through the same context value as before.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AgentSummary, ProjectSummary } from "@prismshadow/penguin-server/api";
import { useStore } from "zustand/react";
import { createStore } from "zustand/vanilla";
import * as api from "../api/endpoints";
import { S } from "../lib/strings";
import { COMMON_SCOPE_ID, isCommonScope, resolveCurrentProjectId } from "../lib/common-scope";
import { useAuth } from "./auth";
import { useLocale } from "./locale";

/** Remembered scope selection; a pinned store never reads or writes it. */
export const PROJECT_KEY = "penguin.lastProjectId";
const agentKey = (projectId: string) => `penguin.lastAgentId.${projectId}`;

interface ProjectContextValue {
  projects: ProjectSummary[];
  projectsLoading: boolean;
  currentProject: ProjectSummary | null;
  /**
   * Whether this context reads the reserved common configuration scope. Derived here rather than
   * re-checked per consumer, so every page asks the same question of the same value: true exactly
   * under a Provider pinned to the scope (the settings page's global sections), false in the
   * app's own context, which always stands in a Project.
   */
  commonScope: boolean;
  setCurrentProjectId: (projectId: string) => void;
  reloadProjects: () => Promise<void>;

  agents: AgentSummary[];
  agentsLoading: boolean;
  currentAgent: AgentSummary | null;
  setCurrentAgentId: (agentId: string) => void;
  reloadAgents: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

/** Project display name fallback: falls back to projectId when name is absent. */
export function projectDisplayName(p: ProjectSummary): string {
  return p.name ?? p.projectId;
}

/** Agent display name fallback: falls back to agentId when name is absent. */
export function agentDisplayName(a: AgentSummary): string {
  return a.name ?? a.agentId;
}

/**
 * A `ProjectSummary`-shaped stand-in for the common configuration scope.
 *
 * The scope is not a Project — it has no row, no members and never appears in the Project list —
 * but everything downstream reads the current scope through `ProjectSummary` (the switcher's
 * label, the pages' `role === "owner"` gate, the per-scope localStorage keys). Synthesizing the
 * shape keeps that single reading path instead of teaching each consumer about a second kind of
 * context. `role: "owner"` mirrors what the server itself resolves for an admin on the reserved
 * id, so gated actions behave here exactly as they do in a Project the admin owns.
 *
 * `name` is the localized label, so it is passed in by the Provider (which re-derives on a
 * locale change) rather than read from the module-level `S` binding here.
 */
export function commonScopeSummary(name: string, userId: string): ProjectSummary {
  return {
    projectId: COMMON_SCOPE_ID,
    name,
    role: "owner",
    ownerUserId: userId,
    // The scope has no creation time; the epoch matches the synthetic row the server returns.
    createdAt: new Date(0).toISOString(),
  };
}

/** Store state: the context value's raw ingredients (currentProject/currentAgent are derived in the Provider) plus the mutation functions. */
interface ProjectStoreState {
  projects: ProjectSummary[];
  projectsLoading: boolean;
  currentProjectId: string | null;

  agents: AgentSummary[];
  agentsLoading: boolean;
  currentAgentId: string | null;

  setCurrentProjectId: (projectId: string) => void;
  reloadProjects: () => Promise<void>;
  setCurrentAgentId: (agentId: string) => void;
  reloadAgents: () => Promise<void>;
}

/**
 * One instance per Provider mount. Exported for tests — the pinned-scope semantics in
 * test/pinned-common-scope.test.ts are the store's, not any component's — while the Provider
 * remains the only runtime creator.
 *
 * `pinnedCommon` builds the store the System settings page's global sections read through: it
 * stands on the reserved common id from birth, owns no Project selection (no remembered read, no
 * prefs write, no re-pointing) and keeps its Agent list under that scope's own key. The pages
 * under it are the very ones a Project shows — the flag is what makes them read common data.
 */
export function createProjectStore(pinnedCommon = false) {
  return createStore<ProjectStoreState>((set, get) => ({
    projects: [],
    // A pinned store has no Project list to wait for: it never has one.
    projectsLoading: !pinnedCommon,
    currentProjectId: pinnedCommon ? COMMON_SCOPE_ID : null,

    agents: [],
    agentsLoading: true,
    currentAgentId: null,

    reloadProjects: async () => {
      // A pinned store stands on a scope the Project list cannot contain, so there is nothing to
      // read and nothing to resolve: the reserved id would only be bounced back to a Project.
      if (pinnedCommon) {
        set({ projectsLoading: false });
        return;
      }
      set({ projectsLoading: true });
      try {
        const res = await api.listProjects();
        set({
          projects: res.projects,
          // The reserved scope is not in that list, so the decision (keep it / fall back to a
          // real Project) is the tested helper's, not an inline `find` that would eject an
          // admin from the common scope on every reload.
          currentProjectId: resolveCurrentProjectId({
            current: get().currentProjectId,
            remembered: localStorage.getItem(PROJECT_KEY),
            projectIds: res.projects.map((p) => p.projectId),
          }),
        });
      } catch {
        // Fail-soft, and deliberately without touching the selection: a failed list read must
        // not eject the user from the Project they are in (a data root with a conflicting
        // "common" Project id answers 409 on every read). The list is left as it was; the pages
        // report their own failures.
      } finally {
        set({ projectsLoading: false });
      }
    },

    setCurrentProjectId: (projectId) => {
      // A pinned store is not the app's scope: nothing under it may re-point it (the switcher is
      // not even rendered there), and a call that tried would write the reserved id into the
      // remembered selection the app's own store reads.
      if (pinnedCommon) return;
      // If the selection is already the current Project, return immediately. Otherwise the
      // code below would clear agents and set loading back to true while currentProjectId
      // stays unchanged — the Provider's reloadAgents effect depends on it and wouldn't rerun,
      // so the Agent list (and the Session list mounted under it) would disappear for good
      // (reproducible by clicking the already-current Project in the dropdown).
      if (projectId === get().currentProjectId) return;
      localStorage.setItem(PROJECT_KEY, projectId);
      // Clear the Agent list in sync: avoids a transient render with "new projectId + old
      // Project's agents" that would make downstream consumers (Sessions) fetch with the
      // wrong Agent set (which could create spurious Sessions under the new Project).
      set({
        currentProjectId: projectId,
        currentAgentId: null,
        agents: [],
        agentsLoading: true,
      });
      // Sync server-side prefs (best-effort; failure doesn't affect the local experience).
      // The reserved id travels like any other: the field is free-form JSON on the server and
      // nothing reads it back (this app resolves its scope from localStorage), while a session
      // that cannot be there at all falls back to the first Project through the helper above.
      void api.putPrefs({ lastProjectId: projectId }).catch(() => undefined);
    },

    reloadAgents: async () => {
      const currentProjectId = get().currentProjectId;
      if (!currentProjectId) return;
      set({ agentsLoading: true });
      try {
        const res = await api.listAgents(currentProjectId);
        const wanted = get().currentAgentId ?? localStorage.getItem(agentKey(currentProjectId));
        const found = res.agents.find((a) => a.agentId === wanted);
        // Default to conversing with default_agent.
        const fallback =
          res.agents.find((a) => a.agentId === "default_agent") ?? res.agents[0] ?? null;
        set({ agents: res.agents, currentAgentId: (found ?? fallback)?.agentId ?? null });
      } catch {
        // A scope whose Agent list cannot be read at all (an inaccessible Project, or the common
        // scope blocked by a conflicting Project id) leaves an empty list rather than rejecting:
        // the list under it is cleared, so nothing from the previous scope can be acted on, and
        // the page below reports the failure in its own words.
        set({ agents: [], currentAgentId: null });
      } finally {
        set({ agentsLoading: false });
      }
    },

    setCurrentAgentId: (agentId) => {
      const currentProjectId = get().currentProjectId;
      if (currentProjectId) localStorage.setItem(agentKey(currentProjectId), agentId);
      set({ currentAgentId: agentId });
    },
  }));
}

/**
 * `pinnedCommon` mounts the store the System settings page's global sections read the common
 * scope through (see createProjectStore): it is born on the reserved id and never takes part in
 * the app's Project selection, so the sidebar, the switcher and every conversation behind this
 * Provider keep showing exactly what they showed before it mounted.
 */
export function ProjectProvider({
  children,
  pinnedCommon = false,
}: {
  children: ReactNode;
  pinnedCommon?: boolean;
}) {
  const { user } = useAuth();
  const { locale } = useLocale();
  // The provider mounts inside RequireAuth, which waits for GET /api/me, so `userId` below is
  // already known when the summary is built.
  const [store] = useState(() => createProjectStore(pinnedCommon));
  const state = useStore(store);

  useEffect(() => {
    void store.getState().reloadProjects();
  }, [store]);

  const { currentProjectId } = state;
  useEffect(() => {
    store.setState({ agents: [] });
    void store.getState().reloadAgents();
  }, [store, currentProjectId]);

  const value = useMemo<ProjectContextValue>(() => {
    const listed = state.projects.find((p) => p.projectId === state.currentProjectId) ?? null;
    // `locale` is a dependency because the common scope's display name comes from the live `S`
    // binding: without it a language switch would keep the previous locale's label.
    const currentProject =
      listed ??
      (isCommonScope(state.currentProjectId) && pinnedCommon
        ? commonScopeSummary(S.commonScope.label, user?.userId ?? "")
        : null);
    const currentAgent = state.agents.find((a) => a.agentId === state.currentAgentId) ?? null;
    return {
      projects: state.projects,
      projectsLoading: state.projectsLoading,
      currentProject,
      commonScope: isCommonScope(currentProject?.projectId),
      setCurrentProjectId: state.setCurrentProjectId,
      reloadProjects: state.reloadProjects,
      agents: state.agents,
      agentsLoading: state.agentsLoading,
      currentAgent,
      setCurrentAgentId: state.setCurrentAgentId,
      reloadAgents: state.reloadAgents,
    };
  }, [state, locale, user?.userId, pinnedCommon]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within a ProjectProvider");
  return ctx;
}
