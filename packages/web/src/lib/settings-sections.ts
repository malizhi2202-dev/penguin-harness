/**
 * The System settings pages, and who may see each one.
 *
 * Server-global pages write through /api/admin/settings (or the admin user routes) and
 * belong to admins alone; the personal pages are per-user preferences every signed-in user
 * owns. Two pages additionally depend on how this session runs: the account page only
 * exists where a password can be changed (see offersChangePassword), and user management
 * disappears in desktop mode, where the app is single-user. Updating is not a page here at
 * all — both the server check and the desktop client's live in the sidebar user menu, under
 * the entry that opens this area. The common configuration scope appears here as its three
 * surfaces (a group of its own, below the server's) rather than as a row in that menu: it is
 * configuration, and this is where configuration lives. The rules live here rather than inside
 * the page
 * because this package's vitest runs in Node with no DOM — a pure function is the only
 * thing a test can pin directly — and because rail and content have to apply the same rule
 * to avoid a visible-but-forbidden entry.
 *
 * A page the viewer may not open is dropped from the list entirely rather than rendered
 * disabled: a greyed-out "Proxy" row still tells a non-admin the setting exists and that
 * someone else can reach it.
 *
 * None of this is the boundary. The admin APIs answer a non-admin with 403 whatever the
 * browser chose to render.
 */
import { offersChangePassword } from "./account-menu";
import type { AccountMenuSession } from "./account-menu";

/** A page of the System settings dialog. */
export type SettingsSectionKey =
  | "general"
  | "appearance"
  | "account"
  | "proxy"
  | "uploads"
  | "users"
  | "commonPlugins"
  | "commonModels"
  | "commonAgents";

/**
 * Rail heading a page sits under: the viewer's own preferences, the whole server's settings, and
 * the common configuration scope every Project on this data root draws on.
 */
export type SettingsGroupKey = "personal" | "server" | "global";

export interface SettingsSection {
  readonly key: SettingsSectionKey;
  readonly group: SettingsGroupKey;
}

/** Who is looking, and from where — the union of what the visibility rules consume. */
export interface SettingsViewer extends AccountMenuSession {
  readonly isAdmin: boolean;
}

/**
 * Every page in rail order, with its visibility rule. Pages of one group stay contiguous —
 * the rail renders this list top to bottom and starts a heading wherever the group changes.
 */
const SECTION_RULES: ReadonlyArray<SettingsSection & { visible(viewer: SettingsViewer): boolean }> =
  [
    { key: "general", group: "personal", visible: () => true },
    { key: "appearance", group: "personal", visible: () => true },
    // The desktop shell's own window has no password to change; a password-established
    // session against the same server still does. Same predicate as the old menu row.
    { key: "account", group: "personal", visible: (v) => offersChangePassword(v) },
    { key: "proxy", group: "server", visible: (v) => v.isAdmin },
    { key: "uploads", group: "server", visible: (v) => v.isAdmin },
    // Single-user under the desktop shell: the server rejects the admin user routes there.
    { key: "users", group: "server", visible: (v) => v.isAdmin && !v.desktopMode },
    // The common configuration scope, below the server's settings: data-root-wide rather than
    // server-wide, and its three surfaces are pages in their own right (the very Project pages, in
    // the other scope) — hence a group of its own rather than one page that links out: a reader who
    // wants the plugin library should land in the plugin library. Administrators only, like the
    // scope's own routes, which answer 404 for anyone else.
    { key: "commonPlugins", group: "global", visible: (v) => v.isAdmin },
    { key: "commonModels", group: "global", visible: (v) => v.isAdmin },
    { key: "commonAgents", group: "global", visible: (v) => v.isAdmin },
  ];

/**
 * The pages that show the common configuration scope's own data rather than the current
 * Project's. The settings page mounts them under a Provider pinned to that scope
 * (ProjectProvider's `pinnedCommon`), so the pages keep reading their data the one way they
 * always have while the app's own scope — sidebar, switcher, conversations — stays exactly
 * where the reader was.
 */
const GLOBAL_SECTIONS: ReadonlyArray<SettingsSectionKey> = [
  "commonPlugins",
  "commonModels",
  "commonAgents",
];

/** Whether this page renders the common scope's data. */
export function isGlobalSettingsSection(key: SettingsSectionKey): boolean {
  return GLOBAL_SECTIONS.includes(key);
}

/** The settings section that embeds the common scope's Agent templates. */
export const COMMON_AGENTS_SECTION = "commonAgents";

/**
 * An Agent template's editor, as the settings section's own route: the URL carries the scope the
 * way the pinned Provider does, so opening a template from settings cannot land on the Project's
 * Agent of the same id. `tab` is the deep link a card's stat icon carries (see the Agents page).
 */
export function commonAgentEditorPath(agentId: string, tab?: string): string {
  const path = `/settings/${COMMON_AGENTS_SECTION}/${agentId}`;
  return tab === undefined ? path : `${path}?tab=${tab}`;
}

/** The pages this viewer may open, in rail order. */
export function visibleSettingsSections(viewer: SettingsViewer): readonly SettingsSection[] {
  return SECTION_RULES.filter((section) => section.visible(viewer)).map(({ key, group }) => ({
    key,
    group,
  }));
}

/**
 * The group headings to draw for `sections`, in order and without repeats. A viewer left
 * with a single group gets one entry, which the rail takes as its cue to draw no heading
 * at all — a lone "Personal" heading implies the other group.
 */
export function settingsGroups(sections: readonly SettingsSection[]): readonly SettingsGroupKey[] {
  const seen: SettingsGroupKey[] = [];
  for (const section of sections) if (!seen.includes(section.group)) seen.push(section.group);
  return seen;
}

/**
 * Requested page -> the page to render. An unknown request and one naming a page this
 * viewer may not open resolve identically, to the first visible page: nothing about what a
 * different account would have found there leaks. Null only when nothing is visible.
 */
export function resolveSettingsSection(
  raw: string | null | undefined,
  sections: readonly SettingsSection[],
): SettingsSectionKey | null {
  if (sections.some((section) => section.key === raw)) return raw as SettingsSectionKey;
  return sections[0]?.key ?? null;
}
