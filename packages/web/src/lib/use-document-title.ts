/**
 * Sync the browser tab title (document.title): "{title} · PenguinHarness"
 * when a page title is set, falling back to the app name otherwise. Called
 * at the top level of each page component, updating instantly on route
 * changes or title changes (e.g. an auto-generated Session title delivered
 * via a session_title event).
 */
import { useEffect } from "react";
import { S } from "./strings";

export function useDocumentTitle(
  title: string | null | undefined,
  /**
   * False leaves the tab title to whoever set it last: a page rendered inside the settings dialog
   * (see `embedded` on the three common-scope pages) is not a destination, and naming the tab
   * after it would outlive the dialog, since the page that owns the route does not re-run its own
   * title effect when the dialog closes.
   */
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    document.title = title ? `${title} · ${S.appName}` : S.appName;
  }, [title, enabled]);
}
