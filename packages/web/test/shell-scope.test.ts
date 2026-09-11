/**
 * The app shell shows the app's own scope and nothing else.
 *
 * The bug this pins: opening System settings → 插件库 used to switch the app's scope to the
 * common configuration scope for the duration of the visit, so the sidebar's nav group became
 * that scope's three pages and its conversations disappeared — the column was showing a
 * different app than the one the reader was in. The global sections now read the scope through
 * their own pinned Provider (see settings-page.tsx and state/project.tsx), which leaves the shell
 * with nothing scope-dependent to render.
 *
 * Pinned against the sources rather than by rendering them: vitest runs node-only here
 * (`environment: "node"`, no jsdom), and "this file has no common-scope branch" is exactly the
 * invariant — a future branch would have to reintroduce one of these names.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, "..", relative), "utf8");

/** Every name the removed sidebar/app-layout common-scope form was built from. */
const COMMON_SCOPE_NAMES = ["commonScope", "commonScopeNavKeys", "COMMON_SCOPE_ID", "公共配置"];

describe("the app shell (sidebar and rail)", () => {
  for (const file of [
    "src/components/layout/sidebar.tsx",
    "src/components/layout/app-layout.tsx",
  ]) {
    it(`${file} renders the Project nav unconditionally`, () => {
      const source = read(file);
      for (const name of COMMON_SCOPE_NAMES) {
        expect(source, `${file} still branches on ${name}`).not.toContain(name);
      }
      // The nav group still comes from the manifest, so pinning the absence above cannot have
      // been satisfied by deleting the nav entirely.
      expect(source).toContain("navKeysFor(");
    });
  }
});

describe("the settings page's global sections", () => {
  it("are the only surface that reads the common scope", () => {
    const provider = read("src/state/project.tsx");
    // The borrow existed only to serve these sections; with them reading through the pinned
    // Provider there is nothing left to enter or exit.
    for (const name of ["enterAutoCommon", "exitAutoCommon", "autoCommonFrom"]) {
      expect(provider, `state/project.tsx still carries ${name}`).not.toContain(name);
    }
    // The pinned store itself stays, and stays reachable by name for the sections.
    expect(provider).toContain("pinnedCommon");
  });

  it("has no route guard left over for a scope the app can no longer be in", () => {
    expect(read("src/router.tsx")).not.toContain("RequireProjectScope");
    expect(existsSync(resolve(here, "../src/components/layout/common-scope-notice.tsx"))).toBe(
      false,
    );
  });
});
