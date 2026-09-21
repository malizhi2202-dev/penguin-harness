/**
 * Project alignment timers, parsed from `<projectDir>/timers.toml`.
 *
 * WHY A PROJECT NEEDS ONE. A Session sees the files it is editing; nobody sees the
 * repository's relationship to everything around it. Between two Sessions the branch falls
 * behind its upstream, the working tree keeps uncommitted files, and a change set lands code
 * whose document still describes the old shape. Comparable products each automate one slice
 * of that and stop: repository-upkeep bots fetch on a schedule but never open the tree,
 * doc-sync products correlate docs with code but only when a pull request is opened, merge
 * queues serialise merges but only for pull requests that already exist, and changelog
 * linters demand an entry at CI time — after the drift has already been written. The slice
 * this module adds is the one an Agent product is uniquely placed to close: a Project-scoped
 * timer that periodically (a) brings each repository up to date with its upstream and (b)
 * reports where docs, commits and code disagree, then hands that report to an Agent when the
 * Project asked for a semantic repair. See the docs page /docs/configuration § "Project
 * timers" for the user-facing contract.
 *
 * WHAT A TIMER MAY AND MAY NOT DO. The rails are the ones every auto-merge product converges
 * on, and they are deliberately not configurable:
 * - `fast-forward` is the default and the only sync mode that is always safe: it moves a
 *   branch forward and can never create a merge commit or rewrite history.
 * - `merge` exists for branches that have genuinely diverged, and a conflicting merge is
 *   ABORTED — the workspace is restored to exactly what it was — then reported, never left
 *   half done for the Agent to trip over.
 * - `none` / `fetch` are read-only.
 * - Auto-commit (`commit = "auto"`) writes an ordinary local commit of whatever the work tree
 *   holds, with a message generated from the diff itself. It never amends, never rewrites a
 *   commit, never touches a `.gitignore`d path, and never commits a repository that is mid
 *   merge/rebase — that state is reported, not resolved. The repository's own hooks run, so a
 *   failing pre-commit hook fails the timer instead of being bypassed.
 * - A repository is only merged once its work tree is clean, which is exactly why auto-commit
 *   exists: an Agent's workspace is almost never clean, so "never merge a dirty tree" without
 *   "commit first" would mean the merge step never runs at all.
 * - There is no `rebase` and no `push`. A timer that rewrites history or publishes commits is
 *   a different, much larger decision; it is not a configuration key.
 *
 * INTENT VS STATE. As with Agent schedules, this file is declarative intent that the system
 * never writes back; what happened (last run, next run, failures) lives in SQLite
 * (db/repos/project-timers.ts).
 *
 * One file per Project, because what a timer aligns — the Project's repositories — belongs to
 * the Project and not to any single Agent. A bad entry is reported and skipped rather than
 * invalidating its neighbours, so one typo costs one timer, not the file.
 */
import { isValidId } from "@prismshadow/penguin-core";
import { parse as parseToml } from "smol-toml";
import { MIN_PERIOD_MS, parsePeriod, type SlotSpec } from "./schedule-file.js";

/** How far a timer may go towards its upstream, least consequential first. */
export const TIMER_SYNC_MODES = ["none", "fetch", "fast-forward", "merge"] as const;
export type TimerSyncMode = (typeof TIMER_SYNC_MODES)[number];

/** Whether the pass commits the work tree before syncing. */
export const TIMER_COMMIT_MODES = ["off", "auto"] as const;
export type TimerCommitMode = (typeof TIMER_COMMIT_MODES)[number];

/** A parsed timer definition. `name` is its identity within the Project's file. */
export interface ProjectTimerDefinition extends SlotSpec {
  name: string;
  enabled: boolean;
  /** Original text of the first trigger time (for API echo). */
  startAt: string;
  /** Original text of the period (for API echo); undefined means a one-shot run. */
  period?: string;
  /** Original text of the end time. */
  endAt?: string;
  sync: TimerSyncMode;
  /**
   * `auto` commits whatever the work tree holds before syncing, with a message generated from
   * the staged diff; `off` leaves the tree alone. Auto-commit is what makes the merge step
   * reachable at all — an Agent's workspace is almost never clean.
   */
  commit: TimerCommitMode;
  /** Run the doc / commit / code drift checks and include them in the report. */
  docs: boolean;
  /** When set, and the pass finds drift, hand the report to a Session with this prompt. */
  agentPrompt?: string;
  /** Bound target Session; defaults to creating a new Session each time a hand-off fires. */
  sessionId?: string;
  /** Workspace for new-Session mode. */
  workspace?: string;
  /** Model for new-Session mode (upstream id, always paired with provider). */
  modelId?: string;
  /** Vendor grouping for `modelId`; present exactly when `modelId` is. */
  provider?: string;
}

/** One entry the file declared but that could not be used; its neighbours still run. */
export interface ProjectTimerError {
  /** The entry's name, or `#<index>` when even that was unusable. */
  name: string;
  error: string;
}

export type ProjectTimersParseResult =
  | { ok: true; defs: ProjectTimerDefinition[]; errors: ProjectTimerError[] }
  | { ok: false; error: string };

/** A field either read cleanly (its value, possibly absent) or rejected with its message. */
type FieldRead<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse an ISO 8601 instant into epoch ms plus the original text for echo. */
function parseInstant(value: unknown): { ms: number; raw: string } | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : { ms, raw: value.toISOString() };
  }
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : { ms, raw: value };
}

/** An optional boolean field. */
function readBool(t: Record<string, unknown>, key: string): FieldRead<boolean | undefined> {
  const value = t[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") return { ok: false, error: `${key} must be a boolean` };
  return { ok: true, value };
}

/** An optional non-empty string field; `field` is what the message calls it (TOML key by default). */
function readString(
  t: Record<string, unknown>,
  key: string,
  field = key,
): FieldRead<string | undefined> {
  const value = t[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${field} must be a non-empty string` };
  }
  return { ok: true, value };
}

/**
 * Parses one `[[timer]]` entry into a definition or the message to report for it. Every
 * field is validated here rather than at run time, so the runner never has to defend itself
 * against half a definition.
 */
function parseEntry(t: Record<string, unknown>): ProjectTimerDefinition | string {
  const name = t["name"];
  if (typeof name !== "string" || !isValidId(name)) {
    return "name must be a lowercase id matching ^[a-z][a-z0-9_-]{1,31}$";
  }

  const enabled = readBool(t, "enabled");
  if (!enabled.ok) return enabled.error;

  const startAt = parseInstant(t["start_at"]);
  if (startAt === null) return "start_at is missing or not a valid ISO 8601 instant";

  let period: string | undefined;
  let periodMs: number | undefined;
  if (t["period"] !== undefined) {
    if (typeof t["period"] !== "string") return "period must be a string";
    const ms = parsePeriod(t["period"]);
    if (ms === null) return "period must look like 30m / 12h / 7d";
    if (ms < MIN_PERIOD_MS) return "period is below the 5m minimum";
    period = t["period"].trim();
    periodMs = ms;
  }

  let endAt: { ms: number; raw: string } | undefined;
  if (t["end_at"] !== undefined) {
    const parsedEnd = parseInstant(t["end_at"]);
    if (parsedEnd === null) return "end_at is not a valid ISO 8601 instant";
    if (parsedEnd.ms <= startAt.ms) return "end_at must be later than start_at";
    endAt = parsedEnd;
  }

  let sync: TimerSyncMode = "fetch";
  if (t["sync"] !== undefined) {
    if (typeof t["sync"] !== "string" || !TIMER_SYNC_MODES.includes(t["sync"] as TimerSyncMode)) {
      return `sync must be one of ${TIMER_SYNC_MODES.join(" / ")}`;
    }
    sync = t["sync"] as TimerSyncMode;
  }

  const docs = readBool(t, "docs");
  if (!docs.ok) return docs.error;

  let commit: TimerCommitMode = "off";
  if (t["commit"] !== undefined) {
    if (
      typeof t["commit"] !== "string" ||
      !TIMER_COMMIT_MODES.includes(t["commit"] as TimerCommitMode)
    ) {
      return `commit must be one of ${TIMER_COMMIT_MODES.join(" / ")}`;
    }
    commit = t["commit"] as TimerCommitMode;
  }

  const agentPrompt = readString(t, "agent_prompt", "agent_prompt");
  if (!agentPrompt.ok) return agentPrompt.error;
  if (agentPrompt.value !== undefined && agentPrompt.value.length > 100_000) {
    return "agent_prompt is longer than 100000 characters";
  }

  const fields: Record<"sessionId" | "workspace" | "modelId" | "provider", string | undefined> = {
    sessionId: undefined,
    workspace: undefined,
    modelId: undefined,
    provider: undefined,
  };
  for (const [key, tomlKey] of [
    ["sessionId", "session_id"],
    ["workspace", "workspace"],
    ["modelId", "model_id"],
    ["provider", "provider"],
  ] as const) {
    const read = readString(t, tomlKey);
    if (!read.ok) return read.error;
    fields[key] = read.value;
  }
  const { sessionId, workspace, modelId, provider } = fields;

  // Same target rules as an Agent schedule: a bound Session and a new-Session target are
  // mutually exclusive, and a model reference is always a complete pair.
  if (
    sessionId !== undefined &&
    (workspace !== undefined || modelId !== undefined || provider !== undefined)
  ) {
    return "Pick one target: workspace and provider / model_id are only for new-Session mode";
  }
  if ((modelId === undefined) !== (provider === undefined)) {
    return "provider and model_id must be given together (a model reference is always a pair)";
  }
  if (agentPrompt.value === undefined && (sessionId !== undefined || modelId !== undefined)) {
    // A target with no prompt has nothing to send: refused rather than silently ignored.
    return "session_id / workspace / model_id / provider only mean something together with agent_prompt";
  }

  return {
    name,
    enabled: enabled.value ?? false,
    startAt: startAt.raw,
    startAtMs: startAt.ms,
    ...(period !== undefined ? { period, periodMs } : {}),
    ...(endAt !== undefined ? { endAt: endAt.raw, endAtMs: endAt.ms } : {}),
    sync,
    docs: docs.value ?? true,
    commit,
    ...(agentPrompt.value !== undefined ? { agentPrompt: agentPrompt.value } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

/**
 * Parses the whole file. `ok: false` means the file itself is unusable (not TOML, not a
 * table, `timer` not an array of tables); `ok: true` with a non-empty `errors` means some
 * entries were usable and the rest are reported by name.
 */
export function parseProjectTimersFile(raw: string): ProjectTimersParseResult {
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse TOML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: "Content is not a TOML table" };
  }
  const entriesRaw = (parsed as Record<string, unknown>)["timer"];
  if (entriesRaw === undefined) return { ok: true, defs: [], errors: [] };
  if (!Array.isArray(entriesRaw)) {
    return { ok: false, error: "timer must be an array of tables ([[timer]])" };
  }

  const defs: ProjectTimerDefinition[] = [];
  const errors: ProjectTimerError[] = [];
  const seen = new Set<string>();
  entriesRaw.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ name: `#${index}`, error: "timer must be a table" });
      return;
    }
    const table = entry as Record<string, unknown>;
    const claimed = table["name"];
    const result = parseEntry(table);
    if (typeof result === "string") {
      errors.push({ name: typeof claimed === "string" ? claimed : `#${index}`, error: result });
      return;
    }
    if (seen.has(result.name)) {
      errors.push({ name: result.name, error: "duplicate timer name" });
      return;
    }
    seen.add(result.name);
    defs.push(result);
  });
  return { ok: true, defs, errors };
}

/**
 * The starting content offered when a Project has no timers file yet: the pass an empty
 * Project wants, written out rather than described, so "turn it on" is one edit
 * (`enabled = true`) instead of a schema to look up.
 */
export const PROJECT_TIMERS_TEMPLATE = `# Project alignment timers. Each [[timer]] runs the Project's alignment pass on its own
# schedule: bring every repository up to date with its upstream, then report where docs,
# commits and code disagree. The system never writes this file back.
#
# sync: none | fetch | fast-forward | merge   (default fetch; fast-forward only ever moves a
#       branch forward, merge is aborted and reported on conflict, neither ever pushes)
# commit: off | auto   (default off; auto commits the work tree with a message generated from
#       the diff before syncing — the step that makes a merge possible in a busy workspace)
# docs: run the documentation / commit / code drift checks (default true)
#
# The repositories aligned are the ones this Project's Workspaces sit in — the same set the
# Git panel shows. There is no repository list to configure, on purpose.

[[timer]]
name = "git-align"
enabled = false
start_at = "2026-01-01T09:00:00+08:00"
period = "1h"
sync = "fast-forward"
commit = "auto"
docs = true
# agent_prompt = "The alignment report below lists where this Project's docs and code have
# drifted. Fix the documentation so it matches the code, and reply with what you changed."
`;
