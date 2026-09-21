# Alignment timers: a Project's repositories, kept aligned on a schedule

- **Date:** 2026-09-21
- **Type:** feature
- **Scope:** `core`, `server`, `web`, `docs`

[中文版](2026-09-21-project-timers.zh.md)

A Project can now declare `timers.toml`, and a timer periodically aligns the Project's local
repositories with their upstreams, checks the documentation against the code, and — when asked —
hands what it found to an Agent. The right dock gains a 对齐定时器 panel: the timers, their next
and last run, the last report per repository, an editor for the file itself, and run history.
Repositories are the ones the Project's Workspaces sit in, the same set the Git panel shows; there
is no repository list to configure.

One run does three things in a fixed order. It commits the work tree when `commit = "auto"`, with a
message generated from the diff. It fetches, then brings each branch up to date by fast-forward, or
by merge when `sync = "merge"`. Then it reports drift: code that changed while no document did,
documents that changed while no code did, a changed document whose relative link or code-span path
points at nothing (`file:line`), and local commits that have not landed upstream. Committing first
is deliberate: "never merge a dirty tree" would otherwise mean the merge step never runs in a
Workspace an Agent has been editing.

## Details

- The file is `<projectDir>/timers.toml`, one `[[timer]]` per task, hand-editable. `enabled`
  defaults to `false`, `sync` to `fetch`, `commit` to `off` and `docs` to `true`, so a
  half-written entry changes nothing. `period` takes `30m` / `12h` / `7d` with a 5-minute floor;
  omitting it makes a one-shot.
- Scheduling reuses the Agent-schedule model exactly, because a user who understands one should not
  have to learn a second: the file is intent and is never written back, run state is in SQLite, a
  due time already past when the server first sees a timer is consumed rather than replayed, and a
  slot is consumed whether the pass succeeds or fails — so a failure is reported instead of
  retried in a loop. Deleting an entry deletes its state and history.
- Git work goes through the same validated service the Git panel uses: `execFile` with argv only,
  every value checked, `GIT_TERMINAL_PROMPT=0`, per-command timeouts. The new primitives are
  fast-forward-or-merge with an abort on conflict, work-tree staging and commit, and the
  operation-in-progress guard.
- Two tables, `project_timer_state` and `project_timer_runs`, arrive as migration 5 (swap-safe, with
  a `down`). Runs left open by a process that died are relabelled `interrupted` at startup rather
  than reported as still running.
- Routes live under `/api/projects/:projectId/timers/`: read for any member, write and run for the
  owner. A file that cannot be interpreted at all is refused; a file with one bad entry is saved
  and that entry's error is returned, so one typo does not cost the other nine timers their save.
- The hand-off is the semantic half: when a timer sets `agent_prompt` and the pass finds something
  worth attention, the report becomes a Prompt in a Session — the Project's built-in Agent, or a
  bound `session_id`. A busy bound Session means the hand-off is skipped this round rather than
  queued indefinitely; the next run reports the same findings.
- Known limits, written down rather than discovered: nothing here talks to a hosting platform, so
  there is no pull-request, review or CI awareness and "commits not landed" is the local stand-in;
  the checks are pattern-based, so a document whose meaning quietly stopped matching the code is not
  detected; and the reference check proves a path exists, not that the prose around it is still
  true.
