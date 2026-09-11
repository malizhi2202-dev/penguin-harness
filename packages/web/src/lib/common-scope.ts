/**
 * The data root's **common configuration scope**: a reserved, non-Project scope whose id is
 * `"common"` and which lives at the same `<root>/common/…` layout a Project uses. An
 * administrator configures Models, Agent templates and the default plugin set there once;
 * ordinary Projects *copy* from it and are independent afterwards (core's common-config.ts
 * holds the storage rules).
 *
 * The backend serves it through the ordinary Project routes — every `/api/projects/common/…`
 * call is admin-only, 404 for anyone else, exactly like an inaccessible Project — plus two
 * `/api/common` reads any signed-in user may make (the default plugin set and the template
 * listing the create-Agent dialog offers).
 *
 * In the Web App the scope has exactly one surface: the System settings page's global sections
 * (插件库 / 模型库 / 智能体), which read it through a Provider pinned to this id. The app's own
 * scope never becomes it — no switcher row, no sidebar form, no route that borrows it.
 *
 * The literal lives here, and only here, in the Web App: `COMMON_SCOPE_ID` is defined in
 * `@prismshadow/penguin-core`, which this package must not import (server code would enter the
 * browser bundle — see the header of api/endpoints.ts), and the server's `/api` entry publishes
 * *types* only. The id is a data-root layout constant, not a value either side expects to drift.
 */
export const COMMON_SCOPE_ID = "common";

/** Whether a scope id names the reserved common configuration scope. */
export function isCommonScope(projectId: string | null | undefined): boolean {
  return projectId === COMMON_SCOPE_ID;
}

/**
 * Resolves which Project id the app should sit in after a Project list read.
 *
 * The app's own scope is always a real Project: the reserved scope is not one, has no row in the
 * list and no conversation behind it, and it is read only through the pinned Provider the System
 * settings page's global sections mount (state/project.tsx). A `"common"` left in localStorage by
 * an earlier build is therefore just an id the list does not carry, and falls back like any other
 * remembered id that is gone — the reader lands in a Project instead of a scope with no surface.
 *
 * Pure on purpose (unit-tested): the store owns the fetch, this owns the decision.
 */
export function resolveCurrentProjectId(input: {
  /** The scope the app currently holds, if any. */
  current: string | null;
  /** The value remembered from the last session (localStorage), used when `current` is empty. */
  remembered: string | null;
  /** The Project ids the server just listed, in server order. */
  projectIds: readonly string[];
}): string | null {
  const wanted = input.current ?? input.remembered;
  const found = input.projectIds.find((id) => id === wanted);
  return found ?? input.projectIds[0] ?? null;
}
