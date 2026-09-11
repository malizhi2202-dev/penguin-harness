/**
 * The one thing the server says when the common configuration scope is unavailable, in one place:
 * a data root can carry a real Project under the reserved id `common` (creation refused it only
 * from the release that introduced the scope), and while it does, every common-scope-only surface
 * reports this conflict instead of reading or writing a directory that belongs to that Project.
 *
 * Its own module so the route layer and the config service cannot drift apart on the wording — the
 * message is the only guidance a user gets, and it has to name the actual remedy: a Project's id is
 * immutable through every surface by design, so moving one off the id is a data-root operation
 * (see the docs' common-config section and this batch's compatibility changelog entry).
 *
 * Removal condition: the guard exists only for the upgrade window described in
 * `ProjectService.isCommonScopeBlocked`; delete this module with it.
 */
import { HttpError } from "../http/errors.js";

/** The reserved id, used in the message (kept beside it so the two cannot disagree). */
const RESERVED_ID = "common";

export function commonScopeConflict(): HttpError {
  return new HttpError(
    409,
    "common_scope_conflict",
    `A Project holds the reserved id "${RESERVED_ID}", so the common configuration scope is unavailable. ` +
      `Delete that Project, or change its id and its directory, to enable the scope.`,
  );
}
