/**
 * settings-sections.ts unit tests: which System settings pages each viewer gets.
 *
 * The rule is pinned by value rather than by shape because both halves of it can fail
 * silently and separately: a rail that shows a forbidden entry leaks that the setting
 * exists, and an active page rendered without the same filter hands a non-admin the form
 * itself. Both go through these functions, so both are covered here.
 *
 * The client filter is convenience, not the boundary — the admin APIs answer a non-admin
 * with 403 either way (server/test/admin-settings.test.ts, "non-admin access is always
 * 403").
 *
 * vitest runs node-only here (`environment: "node"`, no jsdom), so this asserts against
 * the exported functions and, for the settings page's use of them, its source
 * (account-menu.test.ts convention).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMON_AGENTS_SECTION,
  commonAgentEditorPath,
  isGlobalSettingsSection,
  resolveSettingsSection,
  settingsGroups,
  visibleSettingsSections,
} from "../src/lib/settings-sections";

/** Admin signed into a plain `penguin server` through the login form. */
const admin = visibleSettingsSections({
  isAdmin: true,
  desktopMode: false,
  sessionVia: "password",
});
/** Ordinary account on the same server. */
const plain = visibleSettingsSections({
  isAdmin: false,
  desktopMode: false,
  sessionVia: "password",
});
/** The desktop shell's own window: single-user, token session, no password to change. */
const shell = visibleSettingsSections({
  isAdmin: true,
  desktopMode: true,
  sessionVia: "desktop",
});
/** A browser signed into that same desktop-mode server over loopback, with a real password. */
const desktopBrowser = visibleSettingsSections({
  isAdmin: true,
  desktopMode: true,
  sessionVia: "password",
});

describe("visibleSettingsSections", () => {
  it("gives a web admin every page, in rail order", () => {
    expect(admin.map((s) => s.key)).toEqual([
      "general",
      "appearance",
      "account",
      "proxy",
      "uploads",
      "users",
      "commonPlugins",
      "commonModels",
      "commonAgents",
    ]);
  });

  it("gives a non-admin their own pages and nothing server-global", () => {
    // Not "fewer pages" — the exact list. Proxy, upload limits and user management are
    // admin surfaces, and the whole point of dropping them is that a non-admin is never
    // told they exist. Updating is not among them either way: it lives in the sidebar user
    // menu, outside this dialog, for every account.
    expect(plain.map((s) => s.key)).toEqual(["general", "appearance", "account"]);
  });

  it("strips the desktop shell's window down to what a token session can use", () => {
    // No account page (no password to change — see offersChangePassword), no user
    // management (single-user server).
    expect(shell.map((s) => s.key)).toEqual([
      "general",
      "appearance",
      "proxy",
      "uploads",
      "commonPlugins",
      "commonModels",
      "commonAgents",
    ]);
  });

  it("keeps the account page for a password session against a desktop-mode server", () => {
    // Mirrors the old menu row's two-field rule: that session typed a real password and
    // can still change it, while user management stays desktop-hidden.
    expect(desktopBrowser.map((s) => s.key)).toEqual([
      "general",
      "appearance",
      "account",
      "proxy",
      "uploads",
      "commonPlugins",
      "commonModels",
      "commonAgents",
    ]);
  });
});

describe("settingsGroups", () => {
  it("lists an admin's groups once each, in page order", () => {
    expect(settingsGroups(admin)).toEqual(["personal", "server", "global"]);
  });

  it("collapses to a single group when only one remains, the rail's cue to draw no heading", () => {
    // A lone "Personal" heading announces that some other group exists — which is exactly a
    // non-admin's case, whose every page is personal.
    expect(settingsGroups(plain)).toEqual(["personal"]);
  });
});

describe("resolveSettingsSection", () => {
  it("passes through a page the viewer may open", () => {
    expect(resolveSettingsSection("proxy", admin)).toBe("proxy");
    expect(resolveSettingsSection("appearance", plain)).toBe("appearance");
  });

  it("answers a non-admin asking for a common-scope page the same way", () => {
    // The scope's own routes 404 for them, so the page is dropped rather than rendered empty.
    expect(resolveSettingsSection("commonModels", plain)).toBe("general");
  });

  it("sends a non-admin asking for an admin page to their own first page", () => {
    // Answering identically to an unknown request is the point: a requested key cannot be
    // used to find out that "users" is a real page.
    expect(resolveSettingsSection("users", plain)).toBe("general");
    expect(resolveSettingsSection("proxy", plain)).toBe("general");
    expect(resolveSettingsSection("no-such-section", plain)).toBe("general");
  });

  it("falls back to the first visible page for a missing request", () => {
    expect(resolveSettingsSection(null, admin)).toBe("general");
    expect(resolveSettingsSection(undefined, admin)).toBe("general");
  });

  it("returns null when nothing is visible, rather than inventing a page", () => {
    expect(resolveSettingsSection("general", [])).toBe(null);
  });
});

describe("the System settings page", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/features/settings/settings-page.tsx"),
    "utf8",
  );

  it("builds its rail from the filtered list rather than the full one", () => {
    // Without this the functions above could pass every test while the page mapped over
    // the raw registry and rendered the admin rows to everyone.
    expect(source).toContain("visibleSettingsSections({");
    expect(source).not.toContain("SECTION_RULES");
  });

  it("resolves the page it renders through the same gate on every render", () => {
    // The URL's section is a state value, not a right: a viewer who loses admin mid-visit
    // must fall back to their own first page rather than keep rendering the admin form.
    expect(source).toContain("resolveSettingsSection(raw ?? null, sections)");
  });

  it("makes the rail the address: rows are links to one section each", () => {
    // The page exists so each section has a URL of its own (deep links, the back button);
    // a rail of buttons would navigate in-place and leave the address bar lying.
    expect(source).toMatch(/<NavLink[\s\S]*to=\{`\/settings\/\$\{s\.key\}`\}/);
  });

  it("reads the common scope through its own pinned Provider, never the app's scope", () => {
    // The bug this pins: the global sections used to borrow the app's scope while they rendered,
    // which swapped the sidebar's nav to the scope's pages and hid its conversations. The pinned
    // Provider is the whole fix — it is the only way these pages may reach the scope's data.
    expect(source).toContain("<ProjectProvider pinnedCommon>");
    expect(source).not.toContain("enterAutoCommon");
    expect(source).not.toContain("routeKeepsAutoCommon");
  });
});

describe("commonAgentEditorPath", () => {
  it("names the scope in the URL, so a template never opens as the Project's Agent of that id", () => {
    expect(commonAgentEditorPath("researcher")).toBe("/settings/commonAgents/researcher");
    expect(commonAgentEditorPath("researcher", "skills")).toBe(
      "/settings/commonAgents/researcher?tab=skills",
    );
    // The section the editor belongs to and the route it lives on are the same string.
    expect(commonAgentEditorPath("x").startsWith(`/settings/${COMMON_AGENTS_SECTION}/`)).toBe(true);
  });
});

describe("isGlobalSettingsSection", () => {
  it("names the pages that render the common scope's data", () => {
    expect(isGlobalSettingsSection("commonPlugins")).toBe(true);
    expect(isGlobalSettingsSection("commonModels")).toBe(true);
    expect(isGlobalSettingsSection("commonAgents")).toBe(true);
  });

  it("leaves every Project-scoped page alone", () => {
    expect(isGlobalSettingsSection("general")).toBe(false);
    expect(isGlobalSettingsSection("uploads")).toBe(false);
    expect(isGlobalSettingsSection("users")).toBe(false);
  });
});
