# Backward compatibility in this batch

- **Date:** 2026-09-11
- **Type:** process
- **Scope:** `core`, `server`

[中文版](2026-09-11-backward-compatibility.zh.md)

Per the repo rule, every compatibility decision of the batch is recorded here once; the feature entries reference this file instead of re-telling it.

## A Project whose id is `common` is not shadowed by the common configuration scope

The common configuration scope reuses the reserved Project id `common`, and creating a Project under that id is refused from this release on. A data root that predates the scope can still carry one, and that Project's directory is the very `<root>/common/` the scope reads and writes.

**What breaks if nothing were done:** the reserved id would win. That Project's members would lose their access (404), its owner could not start a Session in it (400) or rename or delete it, and every common-scope surface would treat that Project's own files as the scope's — including seeding each newly created Project with that Project's Model table and credentials.

**Decision (the user's pick):** a protective fallback rather than a migration. While a Project carries the id, the scope is **off** and that Project is untouched: it resolves as an ordinary Project, so its owner and members keep their access, Sessions still start, and renaming and deleting it work exactly as they did. Each common-scope-only surface answers 409 `common_scope_conflict` — the two `/api/common` reads and the write, `import-common`, and the template listing. Projects created meanwhile are seeded from the built-in presets rather than from that Project's table, and a new Agent gets no default plugin set. The Web App does not offer the common-config switch entry, so nothing in the UI points at a scope that will refuse.

**Scope:** the data root's directory layout and one row in `web.db`'s `projects` table. No file is rewritten and nothing is moved or copied: the fallback only decides which of the two meanings one directory has.

**User action:** none to upgrade. The scope stays unavailable for as long as that Project does. Enabling it takes one of two things, and neither needs a restart — the check runs per call, not at boot:

- **Deleting that Project** (its own delete, which takes its directory with it), or
- **Re-keying it**, for a Project whose data has to be kept: a Project's id names its directory, its Workspace paths and every stored reference, so it is immutable through every surface by design and this is a data-root operation — stop the server, `UPDATE projects SET project_id = '…' WHERE project_id = 'common'`, rename `<root>/common` to `<root>/…` to match, and start again. (Renaming the Project in the UI only changes its display name, which is why it does not resolve the collision.)

The conflict message names both, since it is the only guidance a user gets.

**Removal:** the check is `ProjectService.isCommonScopeBlocked` and its call sites (the `/api/common` routes, `ProjectConfigService`'s common-table read and `importCommonModels`, `AgentService`'s default plugin seeding, `SessionService`'s reserved-id refusal) plus the predicate wiring in `app.ts`; each site says the same in its own comment. It can be deleted once no data root can still carry such a Project — with the id refused at creation, that is purely a question of how long the pre-scope upgrade window is kept open, and it is the maintainer's call at release prep. Deletion is pure: nothing else references the check, and no stored data depends on it.

## Nothing else in the batch needs handling

The scope is additive on disk and on the wire: `<root>/common/` is a new directory (absent by default, and absent means every surface keeps its previous behavior — the built-in model presets, no default plugin set, an empty template list), `AgentCreateRequest.templateAgentId` is an optional field on an existing route, and the new endpoints carry no previously stored shape. An empty `pluginNames` now means "explicitly no plugins" where it previously meant the same thing by omission too — no data on disk encoded that distinction, so no stored request is reinterpreted. A `lastProjectId` pref that names the reserved scope resolves like any stale id: the Project list lookup misses and the user lands on their first accessible Project.

Recorded here only to state that the check was made.
