/**
 * Repo for Project alignment timers: intent and state are separate — `timers.toml` is
 * declarative intent that the system never writes back, and this table only records runtime
 * state (which scheduled slot was consumed, what the last run did, whether the timer is
 * invalid) plus the run history the panel reads.
 *
 * Identity rule, the same one Agent schedules use: a change to `start_at` is treated as a new
 * timer instance (registerOrSync resets the consumed-slot state); a change to the file content
 * fingerprint only clears the invalid flag, so an edited file takes effect again.
 */
import type { DatabaseSync } from "node:sqlite";

export interface ProjectTimerStateRow {
  projectId: string;
  name: string;
  defHash: string;
  startAtMs: number;
  lastSlotMs: number | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** JSON `AlignmentSummary` of the last finished run. */
  lastSummary: string | null;
  invalidReason: string | null;
}

export interface ProjectTimerRunRow {
  runId: string;
  projectId: string;
  name: string;
  /** `schedule` (the tick fired it) or `manual` (someone pressed run). */
  trigger: string;
  /** The pass reported without touching the work tree. */
  dryRun: boolean;
  startedAt: string;
  /** NULL while it runs, and after a process that died mid-run — see `markStaleRunsInterrupted`. */
  finishedAt: string | null;
  status: string;
  /** JSON `AlignmentSummary`. */
  summary: string | null;
}

function mapState(r: Record<string, unknown>): ProjectTimerStateRow {
  return {
    projectId: r.project_id as string,
    name: r.name as string,
    defHash: r.def_hash as string,
    startAtMs: Number(r.start_at_ms),
    lastSlotMs: r.last_slot_ms === null ? null : Number(r.last_slot_ms),
    lastRunAt: (r.last_run_at as string | null) ?? null,
    lastStatus: (r.last_status as string | null) ?? null,
    lastSummary: (r.last_summary as string | null) ?? null,
    invalidReason: (r.invalid_reason as string | null) ?? null,
  };
}

function mapRun(r: Record<string, unknown>): ProjectTimerRunRow {
  return {
    runId: r.run_id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    trigger: r.trigger as string,
    dryRun: Number(r.dry_run) === 1,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    status: r.status as string,
    summary: (r.summary as string | null) ?? null,
  };
}

export class ProjectTimersRepo {
  constructor(private readonly db: DatabaseSync) {}

  find(projectId: string, name: string): ProjectTimerStateRow | null {
    const r = this.db
      .prepare("SELECT * FROM project_timer_state WHERE project_id = ? AND name = ?")
      .get(projectId, name);
    return r ? mapState(r as Record<string, unknown>) : null;
  }

  listByProject(projectId: string): ProjectTimerStateRow[] {
    const rows = this.db
      .prepare("SELECT * FROM project_timer_state WHERE project_id = ? ORDER BY name")
      .all(projectId);
    return rows.map((r) => mapState(r as Record<string, unknown>));
  }

  /**
   * Register or sync a timer's runtime state, returning the row plus a `fresh` flag:
   * insert when it is new, reset the consumed slots when `start_at` moved (a new instance),
   * and otherwise let a fingerprint change only clear the invalid flag. `fresh` is where the
   * runner establishes its "missed, don't backfill" baseline — the same rule as schedules.
   */
  registerOrSync(args: { projectId: string; name: string; startAtMs: number; defHash: string }): {
    row: ProjectTimerStateRow;
    fresh: boolean;
  } {
    const existing = this.find(args.projectId, args.name);
    let fresh = false;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO project_timer_state (project_id, name, start_at_ms, def_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .run(args.projectId, args.name, args.startAtMs, args.defHash);
      fresh = true;
    } else if (existing.startAtMs !== args.startAtMs) {
      this.db
        .prepare(
          `UPDATE project_timer_state
             SET start_at_ms = ?, def_hash = ?, last_slot_ms = NULL, last_run_at = NULL,
                 last_status = NULL, last_summary = NULL, invalid_reason = NULL
           WHERE project_id = ? AND name = ?`,
        )
        .run(args.startAtMs, args.defHash, args.projectId, args.name);
      fresh = true;
    } else if (existing.defHash !== args.defHash) {
      this.db
        .prepare(
          `UPDATE project_timer_state SET def_hash = ?, invalid_reason = NULL
           WHERE project_id = ? AND name = ?`,
        )
        .run(args.defHash, args.projectId, args.name);
    }
    const row = this.find(args.projectId, args.name);
    if (!row) throw new Error("Failed to read back project_timer_state after registration");
    return { row, fresh };
  }

  /** Advance the consumed scheduled slot (advances whether it ran or was skipped; a restart never re-runs it). */
  markSlot(projectId: string, name: string, slotMs: number): void {
    this.db
      .prepare("UPDATE project_timer_state SET last_slot_ms = ? WHERE project_id = ? AND name = ?")
      .run(slotMs, projectId, name);
  }

  /** Open a run row before the pass starts, so a process that dies mid-run leaves evidence. */
  startRun(run: {
    runId: string;
    projectId: string;
    name: string;
    trigger: string;
    dryRun: boolean;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO project_timer_runs (run_id, project_id, name, trigger, dry_run, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(run.runId, run.projectId, run.name, run.trigger, run.dryRun ? 1 : 0, run.startedAt);
  }

  /** Close a run and fold its outcome into the timer's state in one step. */
  finishRun(args: {
    runId: string;
    projectId: string;
    name: string;
    finishedAt: string;
    status: string;
    /** The report, or null when the pass failed before producing one. */
    summary: string | null;
  }): void {
    this.db
      .prepare(
        "UPDATE project_timer_runs SET finished_at = ?, status = ?, summary = ? WHERE run_id = ?",
      )
      .run(args.finishedAt, args.status, args.summary, args.runId);
    this.db
      .prepare(
        `UPDATE project_timer_state SET last_run_at = ?, last_status = ?, last_summary = ?
         WHERE project_id = ? AND name = ?`,
      )
      .run(args.finishedAt, args.status, args.summary, args.projectId, args.name);
  }

  /** The timer's most recent runs, newest first. */
  listRuns(projectId: string, name: string, limit: number): ProjectTimerRunRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM project_timer_runs WHERE project_id = ? AND name = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(projectId, name, limit);
    return rows.map((r) => mapRun(r as Record<string, unknown>));
  }

  /** Keep the history bounded: everything past `keep` newest rows for this timer goes. */
  pruneRuns(projectId: string, name: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM project_timer_runs
         WHERE project_id = ? AND name = ? AND run_id NOT IN (
           SELECT run_id FROM project_timer_runs WHERE project_id = ? AND name = ?
           ORDER BY started_at DESC LIMIT ?
         )`,
      )
      .run(projectId, name, projectId, name, keep);
  }

  /**
   * Startup honesty: a row still marked running belongs to a process that died mid-pass. It is
   * relabelled rather than deleted — "this ran and never finished" is information.
   */
  markStaleRunsInterrupted(finishedAt: string): number {
    const result = this.db
      .prepare(
        `UPDATE project_timer_runs SET finished_at = ?, status = 'interrupted'
         WHERE finished_at IS NULL`,
      )
      .run(finishedAt);
    return Number(result.changes);
  }

  /** Disable a timer without editing its file (e.g. its bound Session was deleted); an edit clears this. */
  markInvalid(projectId: string, name: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE project_timer_state SET invalid_reason = ? WHERE project_id = ? AND name = ?",
      )
      .run(reason, projectId, name);
  }

  /**
   * Reconciliation cleanup: everything belonging to timers no longer in the file, returning the
   * removed names. History goes with the state — an entry that was deleted and later re-added is
   * a new timer, and showing it the old one's runs would misattribute them.
   */
  deleteMissing(projectId: string, presentNames: readonly string[]): string[] {
    const present = new Set(presentNames);
    const removed: string[] = [];
    for (const row of this.listByProject(projectId)) {
      if (present.has(row.name)) continue;
      this.delete(projectId, row.name);
      removed.push(row.name);
    }
    return removed;
  }

  /** Deleting the file removes the timer: state and history go with it. */
  delete(projectId: string, name: string): void {
    this.db
      .prepare("DELETE FROM project_timer_state WHERE project_id = ? AND name = ?")
      .run(projectId, name);
    this.db
      .prepare("DELETE FROM project_timer_runs WHERE project_id = ? AND name = ?")
      .run(projectId, name);
  }

  deleteByProject(projectId: string): void {
    this.db.prepare("DELETE FROM project_timer_state WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM project_timer_runs WHERE project_id = ?").run(projectId);
  }
}
