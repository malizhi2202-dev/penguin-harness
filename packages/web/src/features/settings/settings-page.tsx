/**
 * System settings, as a page of the app (`/settings/:section`) rather than a modal: the
 * pages it hosts run from two-line preferences to the common configuration scope's plugin,
 * model and Agent libraries — list-and-editor interfaces that want the full height, their
 * own scrolling and an address bar that can name them one by one (deep links, the
 * browser's back button). The avatar menu's row navigates here.
 *
 * Its global sections (the common configuration scope's three libraries) are the app's only
 * surface onto that scope: they read it through a Provider pinned to the reserved id, so the
 * sidebar, its Project switcher and the conversations behind them never move on their account.
 *
 * The rail and the pane both go through visibleSettingsSections, so a viewer neither sees
 * a page they may not open nor lands on one: the URL's section is re-resolved against that
 * list on every render, and an address naming a page this viewer may not open redirects to
 * their first page — nothing about what a different account would have found there leaks.
 * The rail's rows are links, because the rail *is* the address; NavLink supplies each
 * row's active styling and aria-current.
 */
import { useEffect } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { S } from "../../lib/strings";
import {
  isGlobalSettingsSection,
  resolveSettingsSection,
  settingsGroups,
  visibleSettingsSections,
} from "../../lib/settings-sections";
import type { SettingsGroupKey, SettingsSectionKey } from "../../lib/settings-sections";
import { ICON_GAP } from "../../lib/icon-scale";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useAuth } from "../../state/auth";
import { ProjectProvider } from "../../state/project";
import { Icon } from "../../components/ui/group-list";
import { GEAR_ICON, NAV_ICONS } from "../../components/ui/icons";
import { InfoPopover } from "../../components/ui/info-popover";
import { AgentsPage } from "../agents/agents-page";
import { ModelsPage } from "../models/models-page";
import { PluginsPage } from "../plugins/plugins-page";
import { GeneralSection } from "./general-section";
import { AppearanceSection } from "./appearance-section";
import { AccountSection } from "./account-section";
import { ProxySection } from "./proxy-section";
import { UploadsSection } from "./uploads-section";
import { AdminUsersSection } from "../admin/admin-users-page";

/** Rail glyphs, on the shared 24x24 stroke grid (see NAV_ICONS' conventions). */
const SECTION_ICONS: Record<SettingsSectionKey, string> = {
  general: GEAR_ICON,
  /** Sun: appearance. */
  appearance:
    "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4l1.4-1.4",
  /** Single person: the signed-in account. */
  account: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  /** Globe: outbound traffic. */
  proxy:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 0 0 0 18M12 3a15 15 0 0 1 0 18",
  /** Up arrow over a base: uploads. */
  uploads: "M12 15V4m0 0L7 9m5-5l5 5M4 20h16",
  // The common scope's three surfaces wear the marks their nav rows wear: these are those pages.
  commonPlugins: NAV_ICONS.plugins,
  commonModels: NAV_ICONS.models,
  commonAgents: NAV_ICONS.agents,
  /** Two people: user management. */
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
};

/**
 * A rail row: the sidebar's solid-fill active convention. The inactive hover states come
 * from the same scale as every nav row in the app, so the rail reads as navigation rather
 * than as a list of buttons.
 */
const railItemClass = (active: boolean) =>
  `flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150 ${
    active
      ? "bg-gray-200/70 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/70 dark:hover:text-gray-200"
  }`;

export function SettingsPage() {
  // uploadLimits feeds the Upload limits page's "?" (sectionInfo below); the rest pick pages.
  const { user, desktopMode, sessionVia, uploadLimits } = useAuth();
  const sections = visibleSettingsSections({
    isAdmin: user?.isAdmin === true,
    desktopMode,
    sessionVia,
  });
  const { section: raw } = useParams<{ section: string }>();
  const navigate = useNavigate();
  useDocumentTitle(S.settings.systemSettings);

  // The page to render: the URL's section if this viewer may open it, their first page
  // otherwise — the same gate the rail applies, so a URL is a right like a row is.
  const active = resolveSettingsSection(raw ?? null, sections);
  // Everything below is a hook and must run on every render, including the one where no
  // page exists for this viewer: the early return belongs after the last of them.

  // An address naming a page this viewer may not open (or none at all) lands on their first
  // page, exactly as an unknown row would. `replace` keeps the unusable address out of
  // history — back from the landing page returns to where the reader came from.
  useEffect(() => {
    if (active === null || raw === active) return;
    navigate(`/settings/${active}`, { replace: true });
  }, [active, raw, navigate]);

  // The common scope's own pages (embedded below) read their data through the pinned Provider
  // they are mounted under, not through the app's scope: configuring common data here leaves the
  // sidebar, the switcher and every conversation exactly where the reader was, and switching
  // sections (or picking a Project meanwhile) needs no restoring on the way out.
  const scopeWanted = active !== null && isGlobalSettingsSection(active);

  if (active === null) return null;

  // Read inside the component: after a language switch remount, these pick up the current dictionary.
  const sectionLabel: Record<SettingsSectionKey, string> = {
    general: S.settings.generalTitle,
    appearance: S.settings.appearanceTitle,
    account: S.settings.accountTitle,
    proxy: S.settings.proxyTitle,
    uploads: S.settings.uploadLimitsTitle,
    // The three common-scope pages are the nav's own pages, so they carry the nav's names.
    commonPlugins: S.nav.plugins,
    commonModels: S.nav.models,
    commonAgents: S.nav.agents,
    users: S.admin.users,
  };
  const groupLabel: Record<SettingsGroupKey, string> = {
    personal: S.settings.groupPersonal,
    server: S.settings.groupServer,
    global: S.settings.groupGlobal,
  };
  // Page-level explanations, disclosed by the "?" beside the pane heading.
  // Pages whose rows explain themselves one by one carry none.
  const sectionInfo: Partial<Record<SettingsSectionKey, string>> = {
    proxy: S.settings.proxyInfo,
    commonPlugins: S.settings.commonPluginsInfo,
    commonModels: S.settings.commonModelsInfo,
    commonAgents: S.settings.commonAgentsInfo,
    uploads: S.settings.uploadLimitsInfo(uploadLimits.attachmentMaxCount, uploadLimits.imageMaxMb),
  };

  const activeLabel = sectionLabel[active];
  const activeInfo = sectionInfo[active];
  // The libraries bring their own full-width container (mx-auto max-w-5xl inside each); the
  // preference pages read best capped, or their rows stretch past the eye's line length.
  const paneWidth = scopeWanted ? "max-w-5xl" : "max-w-3xl";

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 px-4 pb-3 pt-4 md:px-6">
        <h1 className="text-xl font-semibold">{S.settings.systemSettings}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Rail: vertical beside the pane, a horizontal scroller above it on narrow screens
            — where group headings are dropped along with the second dimension (Tabs'
            convention). The row list is the filtered one: nothing this viewer may not open
            appears here, disabled or otherwise. */}
        <nav
          aria-label={S.settings.systemSettings}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-100 p-2 md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r md:p-3 dark:border-gray-800"
        >
          {settingsGroups(sections).map((group) => (
            <div key={group} className="contents md:mt-3 md:block md:first:mt-0">
              <p className="hidden px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400 md:block dark:text-gray-500">
                {groupLabel[group]}
              </p>
              {sections
                .filter((s) => s.group === group)
                .map((s) => (
                  <NavLink
                    key={s.key}
                    to={`/settings/${s.key}`}
                    className={({ isActive }) => railItemClass(isActive)}
                  >
                    <span aria-hidden className="shrink-0 text-gray-400 dark:text-gray-500">
                      <Icon d={SECTION_ICONS[s.key]} size={16} />
                    </span>
                    <span className="min-w-0 truncate">{sectionLabel[s.key]}</span>
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pt-3 md:px-6 md:pt-4">
            <h2 className={`flex min-w-0 items-center ${ICON_GAP.row} text-lg font-semibold`}>
              {activeLabel}
              {activeInfo !== undefined && (
                <InfoPopover label={activeLabel}>{activeInfo}</InfoPopover>
              )}
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 md:px-6 md:pb-6">
            <div className={paneWidth}>
              {scopeWanted ? (
                /* The common scope's surfaces, embedded: the same pages a Project shows, without
                   their own title or scroll box — this pane is the frame. The pinned Provider is
                   what makes them read the scope the section names, and it is why the three share
                   one: switching between them refetches neither the scope's Agents nor anything
                   else on the page. Nothing here reaches the app's own context. */
                <ProjectProvider pinnedCommon>
                  {active === "commonPlugins" && <PluginsPage embedded />}
                  {active === "commonModels" && <ModelsPage embedded />}
                  {active === "commonAgents" && <AgentsPage embedded />}
                </ProjectProvider>
              ) : (
                <>
                  {active === "general" && <GeneralSection />}
                  {active === "appearance" && <AppearanceSection />}
                  {active === "account" && <AccountSection />}
                  {active === "proxy" && <ProxySection />}
                  {active === "uploads" && <UploadsSection />}
                  {active === "users" && <AdminUsersSection />}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
