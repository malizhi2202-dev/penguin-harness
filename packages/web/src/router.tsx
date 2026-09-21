/**
 * Router (react-router v7 declarative style): /login is public; all other routes go through
 * the RequireAuth guard (redirects to /login when not authenticated) and are wrapped in
 * ProjectProvider + AppLayout.
 *
 * Every route here reads the app's own scope, which is always a Project. The one exception is
 * the common configuration scope's Agent-template editor (`/settings/commonAgents/:agentId`):
 * it mounts its own Provider pinned to that scope, so the URL names the scope the way the
 * settings section it came from does — see state/project.tsx and features/settings/settings-page.
 */
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { useAuth } from "./state/auth";
import { ProjectProvider } from "./state/project";
import { SessionsProvider } from "./state/sessions";
import { AppLayout } from "./components/layout/app-layout";
import { LoginPage } from "./pages/login";
import { ChatPage } from "./features/chat/chat-page";
import { AgentsPage } from "./features/agents/agents-page";
import { AgentSettingsPage } from "./features/agents/agent-settings-page";
import { PluginsPage } from "./features/plugins/plugins-page";
import { ModelsPage } from "./features/models/models-page";
import { SettingsPage } from "./features/settings/settings-page";
import { UsagePage } from "./features/usage/usage-page";
import { BenchmarkPage } from "./features/benchmark/benchmark-page";
import { GitPage } from "./features/git/git-page";
import { TerminalPage } from "./features/terminal/terminal-page";

/** Route guard: shows blank while initializing, redirects to /login when not authenticated. */
function RequireAuth() {
  const { user } = useAuth();
  if (user === undefined) return null; // GET /api/me is still initializing
  if (user === null) return <Navigate to="/login" replace />;
  return (
    <ProjectProvider>
      <SessionsProvider>
        <AppLayout />
      </SessionsProvider>
    </ProjectProvider>
  );
}

/**
 * Login guard without the app shell: the terminal page is a standalone full-window surface
 * (no sidebar, no Project context), it only needs the user to be signed in — the terminal
 * WebSocket authenticates with the same session cookie.
 */
function RequireAuthBare({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (user === undefined) return null;
  if (user === null) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** When already logged in, visiting /login goes to the app home (see HomeRoute). */
function LoginRoute() {
  const { user } = useAuth();
  if (user) return <Navigate to="/" replace />;
  return <LoginPage />;
}

/**
 * Where the app home lands: the chat page, which is the app's own work surface and the one page
 * whose URL does not need to name a Project first. The Project list is no longer awaited here:
 * with the common scope read only inside settings, every scope the app can be in has a chat page
 * (`/` on the way to one of them included), so there is nothing to decide and nothing to bounce.
 */
function HomeRoute() {
  return <Navigate to="/chat" replace />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route
          path="/terminal"
          element={
            <RequireAuthBare>
              <TerminalPage />
            </RequireAuthBare>
          }
        />
        <Route element={<RequireAuth />}>
          <Route index element={<HomeRoute />} />
          <Route path="/chat/:sessionId?" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:agentId" element={<AgentSettingsPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/models" element={<ModelsPage />} />
          {/* System settings, as a page: /settings redirects to the viewer's first section
              (the page canonicalises the URL — see SettingsPage). Its global sections read the
              common scope through their own pinned Provider, so nothing outside the pane moves. */}
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          {/* An Agent template's editor, opened from the section above. Its own route because the
              scope has to travel with the URL: /agents/:agentId reads the Project's Agent of that
              id, which is a different Agent from the template the reader clicked. The pinned
              Provider is what makes the page's own reads — config, Skills, tabs — the scope's. */}
          <Route
            path="/settings/commonAgents/:agentId"
            element={
              <ProjectProvider pinnedCommon>
                <AgentSettingsPage />
              </ProjectProvider>
            }
          />
          {/* Admin-only server-side (403 otherwise); the sidebar hides the row for
              everyone else, so a member only ever reaches this by typing the URL. */}
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/benchmark" element={<BenchmarkPage />} />
          {/* Local git repositories, scanned from the Project's Workspaces (the directories its
              Sessions ran in) plus any directory added by hand on the page itself. */}
          <Route path="/git" element={<GitPage />} />
          {/* Anything else falls through to the home. */}
          <Route path="*" element={<HomeRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
