/**
 * Common configuration scope routes (`/api/common`).
 *
 * Only the piece with no Project-scoped home lives here. The common scope's **Models** and
 * **Agent templates** are addressed through the ordinary Project routes with the reserved scope
 * id (`/api/projects/common/models`, `/api/projects/common/agents/…`) — that reuse is the whole
 * reason the scope is laid out like a Project (see core's COMMON_SCOPE_ID). The **default plugin
 * set** is neither a Project's nor an Agent's: it is the list a newly created Agent is seeded
 * with when its creator picks nothing, so it gets its own two endpoints.
 *
 * Access follows the same rule as every other surface on the reserved id: any signed-in user may
 * read it, and `requireProjectOwner` — which resolves to "admin" there — gates the write. The
 * scope itself is never created implicitly: an unconfigured data root has no `common/` directory
 * and `GET` reports an empty set, which is exactly the pre-existing behavior.
 *
 * Docs: /docs/configuration § "Common config".
 */
import { Hono } from "hono";
import {
  COMMON_SCOPE_ID,
  libraryPlugin,
  loadCommonDefaultPlugins,
  saveCommonDefaultPlugins,
} from "@prismshadow/penguin-core";
import type { CommonAgentTemplatesResponse, CommonPluginsResponse } from "../../api/types.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { badRequest, optionalStringArray, readJson } from "../validate.js";
import { commonScopeConflict } from "../../services/common-scope.js";

/**
 * Refuses a common-scope request while a real Project carries the reserved id (see
 * ProjectService.isCommonScopeBlocked): the scope's files are that Project's own, so every
 * common-scope surface answers with the actionable conflict instead of reading or writing them.
 * The Project itself is untouched — it resolves like any other Project and keeps working.
 */
function requireCommonScopeAvailable(deps: AppDeps): void {
  if (deps.projectService.isCommonScopeBlocked()) throw commonScopeConflict();
}

/** Reads the configured set together with the names the library no longer carries. */
async function readCommonPlugins(root: string): Promise<CommonPluginsResponse> {
  const defaultPlugins = await loadCommonDefaultPlugins(root);
  return {
    defaultPlugins,
    // Reported rather than filtered: a name left behind by a library change is something the
    // user has to see and fix, and silently dropping it would make the next PUT lose it.
    unknownPlugins: defaultPlugins.filter((name) => libraryPlugin(name) === undefined),
  };
}

export function commonRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Read: any signed-in user — the auth middleware already required a session, and this is the
  // configuration every Agent creation applies. Deliberately *not* `requireProjectAccess` on the
  // reserved id: that surface is admin-only (see ProjectService.resolveAccess), while this read is
  // exactly what a non-admin needs to understand what new Agents will inherit.
  app.get("/plugins", async (c) => {
    requireCommonScopeAvailable(deps);
    return c.json(await readCommonPlugins(deps.config.root));
  });

  /**
   * The common Agent templates a Project may create an Agent from — read by any signed-in user,
   * because the create dialog lives in a Project and every member who can create an Agent there
   * has to be able to see what is on offer.
   *
   * This is the one Project-shaped read deliberately served outside the reserved-id routes: the
   * `/api/projects/common/…` surface is admin-only (see ProjectService.resolveAccess), and the
   * read is safe by construction — the listing carries template identity and counts, never
   * config bodies, Skills or credentials.
   */
  app.get("/agent-templates", async (c) => {
    requireCommonScopeAvailable(deps);
    return c.json({
      templates: await deps.agentService.listAgentTemplates(),
    } satisfies CommonAgentTemplatesResponse);
  });

  // Write (admin): replaces the whole set. Every name is resolved against the built-in library
  // before anything is written — an unknown name is a 400 here, not a trap that would make every
  // future Agent creation install a plugin that does not exist.
  app.put("/plugins", async (c) => {
    requireCommonScopeAvailable(deps);
    deps.projectService.requireProjectOwner(c.var.user.userId, COMMON_SCOPE_ID);
    const body = await readJson(c);
    const names = optionalStringArray(body, "defaultPlugins");
    // A whole-set replacement with the field missing is a client bug, and the one way this route
    // could silently clear the set — an explicit `[]` is how a user says "no defaults".
    if (names === undefined) {
      throw badRequest("defaultPlugins is required: send an empty array to clear the default set.");
    }
    const unique = [...new Set(names)];
    if (unique.length !== names.length) {
      throw badRequest("defaultPlugins contains duplicate names.");
    }
    for (const name of unique) {
      if (libraryPlugin(name) === undefined) {
        throw badRequest(`Plugin is not in the library: ${name}`);
      }
    }
    await saveCommonDefaultPlugins(deps.config.root, unique);
    return c.json((await readCommonPlugins(deps.config.root)) satisfies CommonPluginsResponse);
  });

  return app;
}
