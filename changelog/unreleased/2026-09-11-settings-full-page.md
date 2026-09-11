# System settings: from a dialog to a full page

- **Date:** 2026-09-11
- **Type:** feat
- **Scope:** `web`

[中文版](2026-09-11-settings-full-page.zh.md)

System settings is a page at `/settings` with a URL of its own per section, not a dialog over whatever page happened to be open. The entry stays where it was — the sidebar user menu's **System settings** row — it navigates instead of opening.

## Details

- **Every section is addressable.** `/settings/general`, `/settings/appearance`, `/settings/proxy` and so on; `/settings` itself lands on the viewer's first visible section (personal first, so a non-admin never bounces off an admin URL). Sections can be bookmarked and shared, the browser's back button walks between them, and a deep link opens straight to the section it names. An address naming a section the viewer cannot see falls back to their own first section rather than answering with the admin form.
- **Same rail, more room.** The page keeps the dialog's structure — the Personal / Server groups, the same section set, the same admin visibility rules — as a left rail beside the content instead of a rail inside a 70vh box. The three settings library sections (Plugin Library, Models, Agents under the Global config group) render the same full pages a Project uses, embedded but with a full page's width and scroll; the shallower sections keep a narrower reading column.
- **A Global config section carries its own scope, and the app is not touched.** The three library pages render under a Provider pinned to the common config: they read that data, while the app's own scope stays the Project it was — the sidebar, the Project switcher and the session list do not move for the whole visit, and leaving needs nothing put back. A template's editor has a route of its own (`/settings/commonAgents/:agentId`), so the scope travels in the URL and it reads the template rather than the Project's Agent of the same id.
- **Removed:** the settings dialog and its paged-dialog container. Everything they rendered is on the page; the Modal keeps only the uses a real dialog still has.

## Known edges

- A browser Back from the app's first load to `/settings` may land on the section the address names only after the section list resolves; the address bar is canonicalised in place, so no intermediate URL is left in history.
- A template's editor is a route of its own outside the settings surface (it shows no settings rail), which is what its way back matches: both the in-page Back and the browser's return to the Agents section.
