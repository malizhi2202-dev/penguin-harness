/**
 * The common configuration scope's client-side rules.
 *
 * The app's own scope is always a real Project: the scope has no switcher row, no route that
 * borrows it and no conversation behind it, so a `"common"` remembered in localStorage by an
 * earlier build is an id the Project list does not carry and falls back like any other gone id.
 * The id itself stays recognizable — the settings page's pinned Provider is what stands in the
 * scope, and `commonScopeSummary` names it.
 *
 * vitest runs node-only here (`environment: "node"`, no jsdom): the exported functions are pure.
 */
import { describe, expect, it } from "vitest";
import { COMMON_SCOPE_ID, isCommonScope, resolveCurrentProjectId } from "../src/lib/common-scope";

describe("isCommonScope", () => {
  it("recognizes the reserved id and nothing else", () => {
    expect(isCommonScope(COMMON_SCOPE_ID)).toBe(true);
    expect(isCommonScope("common-2")).toBe(false);
    expect(isCommonScope("Common")).toBe(false);
    expect(isCommonScope(null)).toBe(false);
    expect(isCommonScope(undefined)).toBe(false);
  });
});

describe("resolveCurrentProjectId", () => {
  const ids = ["alice-work", "alice-side"];

  it("resolves a listed Project id", () => {
    expect(
      resolveCurrentProjectId({ current: "alice-side", remembered: null, projectIds: ids }),
    ).toBe("alice-side");
  });

  it("falls back to the first Project when the remembered one is gone", () => {
    expect(
      resolveCurrentProjectId({ current: null, remembered: "deleted-project", projectIds: ids }),
    ).toBe("alice-work");
  });

  it("prefers the current selection over the remembered one", () => {
    expect(
      resolveCurrentProjectId({ current: "alice-side", remembered: "alice-work", projectIds: ids }),
    ).toBe("alice-side");
  });

  it("treats the reserved id as a Project the list does not carry", () => {
    // The scope is never the app's own context, so a selection or a memory of it resolves to a
    // real Project instead of stranding the session on a scope with no pages and no sessions.
    expect(
      resolveCurrentProjectId({ current: COMMON_SCOPE_ID, remembered: null, projectIds: ids }),
    ).toBe("alice-work");
    expect(
      resolveCurrentProjectId({ current: null, remembered: COMMON_SCOPE_ID, projectIds: ids }),
    ).toBe("alice-work");
  });

  it("answers null when the user has no Project at all", () => {
    expect(resolveCurrentProjectId({ current: null, remembered: null, projectIds: [] })).toBeNull();
    expect(
      resolveCurrentProjectId({ current: COMMON_SCOPE_ID, remembered: null, projectIds: [] }),
    ).toBeNull();
  });
});
