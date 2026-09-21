/**
 * The Project alignment timer runner: a Web server runtime component, active only while the
 * server runs. At startup it reconciles every Project's `timers.toml`, then keeps ticking.
 *
 * Semantics are deliberately the ones Agent schedules already established, because a user who
 * understands one should not have to learn a second timer:
 * - INTENT VS STATE. The file is declarative and never written back; run state lives in SQLite.
 * - NO BACKFILL. A due slot earlier than when this runner first learned of the timer (startup
 *   reconcile, first registration, a `start_at` reset) is consumed without running; a restart
 *   never replays yesterday's alignments.
 * - A SLOT IS CONSUMED WHATEVER HAPPENS. The slot is marked before the pass starts, so a
 *   failure does not retry in a loop; the next slot is the next attempt. Failures are recorded
 *   and reported, not retried.
 * - DELETE THE FILE, DELETE THE TIMER. Reconciliation cleans up state and history.
 *
 * What it does NOT borrow is the queue. An Agent schedule queues a fire until its bound Session
 * is idle, because the Prompt is the point. A timer's pass runs regardless — the alignment work
 * is git, not a conversation — and only the optional Agent hand-off needs a Session, so a busy
 * one is skipped this round with an error recorded rather than held open indefinitely.
 *
 * Concurrency: one pass per timer at a time, and the tick never overlaps itself. Two passes over
 * the same repository would race on the same index lock, which is exactly what every merge
 * product avoids by serialising per branch (see the alignment service's survey notes).
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_AGENT_ID,
  buildScheduledMessage,
  projectTimersFile,
  userText,
} from "@prismshadow/penguin-core";
import type {
  AlignmentSummary,
  ProjectTimerRunRecord,
  ProjectTimerRunStatus,
  ProjectTimerServerEvent,
  ProjectTimerStatus,
} from "../api/types.js";
import type { ProjectsRepo } from "../db/repos/projects.js";
import type {
  ProjectTimerRunRow,
  ProjectTimerStateRow,
  ProjectTimersRepo,
} from "../db/repos/project-timers.js";
import type { SessionsRepo } from "../db/repos/sessions.js";
import { randomHex8 } from "../services/ids.js";
import {
  buildAgentMessage,
  runAlignment,
  statusOf,
  type AlignmentOptions,
} from "../services/project-alignment.js";
import type { ErrorSink } from "./error-recorder.js";
import { latestSlotAt, nextSlotAfter, slotInWindow, type SlotSpec } from "./schedule-file.js";
import type { ScheduleConfigSource } from "./schedule-store.js";
import { validateScheduleModelRef } from "./schedule-store.js";
import type { ScheduleSessionCreator, ScheduleTaskRunner } from "./scheduler.js";
import {
  parseProjectTimersFile,
  type ProjectTimerDefinition,
  type ProjectTimerError,
} from "./project-timer-file.js";
import { readProjectTimers } from "./project-timer-store.js";

/** Reconcile and run-check interval (the minimum period is 5m, so 60s granularity is plenty). */
const TICK_INTERVAL_MS = 60_000;

/** Run rows kept per timer; the panel shows the last few and the rest is history nobody reads. */
const KEEP_RUNS = 20;

export interface ProjectTimerEntryView {
  def: ProjectTimerDefinition;
  state: ProjectTimerStateRow;
  /** Next scheduled run (epoch ms); null when the timer is disabled, expired, done or invalid. */
  nextRunAt: number | null;
}

export interface ProjectTimersView {
  file: { path: string; raw: string; exists: boolean };
  entries: ProjectTimerEntryView[];
  errors: ProjectTimerError[];
  /** The file itself is unusable; nothing from it is scheduled. */
  fileError?: string;
}

export interface ProjectTimerRunnerDeps {
  root: string;
  repo: ProjectTimersRepo;
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  /** Session runner + creator, shared with the scheduler: a hand-off is an ordinary Prompt. */
  runner: ScheduleTaskRunner;
  sessionCreator: ScheduleSessionCreator;
  /** Project-config source for model-ref validation (same rules as Agent schedules). */
  projectConfig: ScheduleConfigSource;
  errors: ErrorSink;
  notify: (userId: string, event: ProjectTimerServerEvent) => void;
  now?: () => number;
  intervalMs?: number;
  /** Test seam for the alignment pass; the real git pass is the default. */
  alignment?: (options: AlignmentOptions) => Promise<AlignmentSummary>;
}

export class ProjectTimerRunner {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly alignment: (options: AlignmentOptions) => Promise<AlignmentSummary>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Keys (`projectId\0name`) with a pass in flight — one at a time, tick or manual. */
  private readonly running = new Set<string>();
  private ticking = false;

  constructor(private readonly deps: ProjectTimerRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.intervalMs = deps.intervalMs ?? TICK_INTERVAL_MS;
    this.alignment = deps.alignment ?? runAlignment;
  }

  /**
   * Start: relabel the runs a previous process left open, arm the interval, and reconcile.
   *
   * The relabel is awaited — it is one statement, and nothing may be reported as running before
   * it lands. The first pass is NOT: it can fetch from a remote (a 180s command timeout), and a
   * slow network must not hold up the boot of everything else the way the scheduler's file-read
   * reconcile never could.
   */
  async start(): Promise<void> {
    this.deps.repo.markStaleRunsInterrupted(new Date(this.now()).toISOString());
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tickOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One reconcile + run pass (deterministic entry for tests and routes; concurrent calls run only one). */
  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const project of this.deps.projects.listAll()) {
        await this.reconcileProject(project.projectId, project.ownerUserId);
      }
    } catch (err) {
      this.deps.errors.record({ source: "schedule", err, code: "project_timer_tick_failed" });
    } finally {
      this.ticking = false;
    }
  }

  /** The panel's read: the declaration, its state and each timer's next run. */
  async view(projectId: string): Promise<ProjectTimersView> {
    const filePath = projectTimersFile(this.deps.root, projectId);
    const file = await readProjectTimers(this.deps.root, projectId);
    if (file === null) {
      return { file: { path: filePath, raw: "", exists: false }, entries: [], errors: [] };
    }
    if (!file.parsed.ok) {
      return {
        file: { path: filePath, raw: file.raw, exists: true },
        entries: [],
        errors: [],
        fileError: file.parsed.error,
      };
    }
    const nowMs = this.now();
    const entries: ProjectTimerEntryView[] = [];
    for (const def of file.parsed.defs) {
      const stored = this.deps.repo.find(projectId, def.name) ?? emptyState(projectId, def);
      // A model reference the Project cannot resolve is shown the same way a vanished Session is
      // — status invalid, reason on the item — but it is NOT persisted onto the state row, so
      // fixing the Project's model table alone brings the timer back without editing its file.
      const refError =
        stored.invalidReason === null
          ? await validateScheduleModelRef(this.deps.projectConfig, projectId, def)
          : null;
      const state = refError !== null ? { ...stored, invalidReason: refError } : stored;
      const status = timerStatusOf(def, state, nowMs);
      // A next run is only meaningful for a timer that will actually fire.
      entries.push({
        def,
        state,
        nextRunAt: status === "active" ? nextRunAt(def, state, nowMs) : null,
      });
    }
    return {
      file: { path: filePath, raw: file.raw, exists: true },
      entries,
      errors: file.parsed.errors,
    };
  }

  /** The timer's run history, newest first. */
  history(projectId: string, name: string, limit: number): ProjectTimerRunRecord[] {
    return this.deps.repo.listRuns(projectId, name, limit).map((row) => toRunRecord(row));
  }

  /**
   * Run one timer now, outside its schedule. A manual run does NOT consume a scheduled slot —
   * pressing "run" must not silently move the next scheduled pass.
   */
  async runNow(
    projectId: string,
    name: string,
    opts: { dryRun: boolean },
  ): Promise<{ status: ProjectTimerRunStatus; summary: AlignmentSummary | null; runId: string }> {
    const file = await readProjectTimers(this.deps.root, projectId);
    const def = file && file.parsed.ok ? file.parsed.defs.find((d) => d.name === name) : undefined;
    if (def === undefined) return { status: "failed", summary: null, runId: "" };
    const owner = this.deps.projects.findById(projectId)?.ownerUserId ?? null;
    const result = await this.execute(projectId, owner, def, {
      trigger: "manual",
      dryRun: opts.dryRun,
    });
    return { status: result.status, summary: result.summary, runId: result.runId };
  }

  /** Whether a pass for this timer is in flight right now. */
  isRunning(projectId: string, name: string): boolean {
    return this.running.has(this.keyOf(projectId, name));
  }

  /**
   * Reconcile one Project: register state, consume missed slots without running them, then run
   * whatever is due. Also the immediate-effect entry after a route write.
   */
  async reconcileProject(projectId: string, ownerUserId: string | null): Promise<void> {
    const file = await readProjectTimers(this.deps.root, projectId);
    if (file === null) {
      // No file means no timers: drop any state and history left behind by a deleted file.
      this.deps.repo.deleteMissing(projectId, []);
      return;
    }
    if (!file.parsed.ok) {
      this.deps.errors.record({
        source: "schedule",
        err: new Error(`Invalid timers file for ${projectId}: ${file.parsed.error}`),
        code: "project_timer_invalid_file",
        ctx: { projectId },
      });
      return;
    }
    for (const entry of file.parsed.errors) {
      this.deps.errors.record({
        source: "schedule",
        err: new Error(`Invalid timer ${entry.name} in ${projectId}: ${entry.error}`),
        code: "project_timer_invalid_entry",
        ctx: { projectId },
      });
    }

    // The fingerprint is the whole file: an edit to any entry clears the invalid flag for all of
    // them. Coarser than per-entry hashing, and the only thing the flag gates is re-activation
    // after a bound Session disappeared — where being generous is the safe direction.
    const defHash = createHash("sha1").update(file.raw).digest("hex");
    const nowMs = this.now();
    for (const def of file.parsed.defs) {
      const refError = await validateScheduleModelRef(this.deps.projectConfig, projectId, def);
      if (refError !== null) {
        this.deps.errors.record({
          source: "schedule",
          err: new Error(`Invalid timer ${def.name} in ${projectId}: ${refError}`),
          code: "project_timer_invalid_entry",
          ctx: { projectId },
        });
        continue;
      }
      const { row, fresh } = this.deps.repo.registerOrSync({
        projectId,
        name: def.name,
        startAtMs: def.startAtMs,
        defHash,
      });
      let state = row;
      if (fresh) {
        // Baseline: a due time already in the past at registration is consumed, never replayed.
        const slot = latestSlotAt(def, nowMs);
        if (slot !== null) {
          this.deps.repo.markSlot(projectId, def.name, slot);
          state = this.deps.repo.find(projectId, def.name) ?? state;
        }
      }
      if (!def.enabled || state.invalidReason !== null) continue;
      if (def.periodMs === undefined && state.lastSlotMs !== null) continue; // one-shot, consumed
      const slot = latestSlotAt(def, nowMs);
      if (slot === null || !slotInWindow(def, slot)) continue;
      if (state.lastSlotMs !== null && slot <= state.lastSlotMs) continue;
      this.deps.repo.markSlot(projectId, def.name, slot);
      await this.execute(projectId, ownerUserId, def, { trigger: "schedule", dryRun: false });
    }
    this.deps.repo.deleteMissing(
      projectId,
      file.parsed.defs.map((def) => def.name),
    );
  }

  // -------------------------------------------------------------------------

  private keyOf(projectId: string, name: string): string {
    return `${projectId}\0${name}`;
  }

  /** The Project's Workspaces — the same discovery input the Git panel uses. */
  private workspacesOf(projectId: string): string[] {
    return this.deps.sessions.listByProject(projectId).map((s) => s.workspace);
  }

  /** One pass: record it, run it, report it, and hand it to an Agent when it asked for one. */
  private async execute(
    projectId: string,
    ownerUserId: string | null,
    def: ProjectTimerDefinition,
    opts: { trigger: "schedule" | "manual"; dryRun: boolean },
  ): Promise<{ status: ProjectTimerRunStatus; summary: AlignmentSummary | null; runId: string }> {
    const key = this.keyOf(projectId, def.name);
    if (this.running.has(key)) return { status: "running", summary: null, runId: "" };
    this.running.add(key);
    const runId = `run-${randomHex8()}`;
    const startedAt = new Date(this.now()).toISOString();
    this.deps.repo.startRun({
      runId,
      projectId,
      name: def.name,
      trigger: opts.trigger,
      dryRun: opts.dryRun,
      startedAt,
    });
    try {
      const summary = await this.alignment({
        workspaces: this.workspacesOf(projectId),
        sync: def.sync,
        commit: def.commit,
        docs: def.docs,
        dryRun: opts.dryRun,
        timerName: def.name,
        now: this.now,
      });
      const status = statusOf(summary);
      this.deps.repo.finishRun({
        runId,
        projectId,
        name: def.name,
        finishedAt: new Date(this.now()).toISOString(),
        status,
        summary: JSON.stringify(summary),
      });
      this.deps.repo.pruneRuns(projectId, def.name, KEEP_RUNS);
      const sessionId = opts.dryRun ? undefined : await this.maybeHandOff(projectId, def, summary);
      this.notifyFor(ownerUserId, {
        type: "project_timer_ran",
        projectId,
        name: def.name,
        runId,
        status,
        attention: summary.counts.attention,
        handedOff: sessionId !== undefined,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return { status, summary, runId };
    } catch (err) {
      this.deps.errors.record({
        source: "schedule",
        err,
        code: "project_timer_run_failed",
        ctx: { projectId },
      });
      this.deps.repo.finishRun({
        runId,
        projectId,
        name: def.name,
        finishedAt: new Date(this.now()).toISOString(),
        status: "failed",
        summary: null,
      });
      return { status: "failed", summary: null, runId };
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * The semantic half: when the Project wrote a prompt and the pass found something that wants
   * attention, the report becomes a Prompt in a Session. The default Agent is the Project's
   * built-in one; a bound `session_id` sends into that Session instead. Nothing here decides
   * what to change — the Agent does, with the evidence already attached.
   */
  private async maybeHandOff(
    projectId: string,
    def: ProjectTimerDefinition,
    summary: AlignmentSummary,
  ): Promise<string | undefined> {
    if (def.agentPrompt === undefined || summary.counts.attention === 0) return undefined;
    const firedAt = new Date(this.now()).toISOString();
    const text = buildAgentMessage(def.agentPrompt, summary);
    try {
      if (def.sessionId !== undefined) {
        const row = this.deps.sessions.findById(def.sessionId);
        if (!row || row.projectId !== projectId) {
          this.deps.repo.markInvalid(projectId, def.name, "session_missing");
          this.deps.errors.record({
            source: "schedule",
            err: new Error(
              `Timer ${def.name} is bound to a Session that does not exist: ${def.sessionId}`,
            ),
            code: "project_timer_session_missing",
            ctx: { projectId, sessionId: def.sessionId },
          });
          return undefined;
        }
        if (this.deps.runner.statusOf(def.sessionId) !== "idle") {
          // Skipped, not queued: the pass has already happened and the next run reports the
          // same findings. Holding a Session open for it would be a queue with no owner.
          this.deps.errors.record({
            source: "schedule",
            err: new Error(`Timer ${def.name} skipped its hand-off: ${def.sessionId} is running.`),
            code: "project_timer_session_busy",
            ctx: { projectId, sessionId: def.sessionId },
          });
          return undefined;
        }
        await this.deps.runner.startTask(def.sessionId, [
          userText(buildScheduledMessage(def.name, firedAt, text), "server"),
        ]);
        return def.sessionId;
      }
      const info = await this.deps.sessionCreator.createSession({
        projectId,
        agentId: DEFAULT_AGENT_ID,
        ...(def.workspace !== undefined ? { workspace: def.workspace } : {}),
        ...(def.modelId !== undefined ? { modelId: def.modelId } : {}),
        ...(def.provider !== undefined ? { provider: def.provider } : {}),
        source: "schedule",
      });
      await this.deps.runner.startTask(info.sessionId, [
        userText(buildScheduledMessage(def.name, firedAt, text), "server"),
      ]);
      return info.sessionId;
    } catch (err) {
      this.deps.errors.record({
        source: "schedule",
        err,
        code: "project_timer_handoff_failed",
        ctx: { projectId },
      });
      return undefined;
    }
  }

  /** Notify the Project owner (the file's editor); silent when the Project has no owner row. */
  private notifyFor(userId: string | null, event: ProjectTimerServerEvent): void {
    if (userId) this.deps.notify(userId, event);
  }
}

/** A state row for a timer that has never run (the panel reads it before the first tick registers it). */
function emptyState(projectId: string, def: ProjectTimerDefinition): ProjectTimerStateRow {
  return {
    projectId,
    name: def.name,
    defHash: "",
    startAtMs: def.startAtMs,
    lastSlotMs: null,
    lastRunAt: null,
    lastStatus: null,
    lastSummary: null,
    invalidReason: null,
  };
}

/** The next scheduled run: the pending due slot if one is undigested, else the next one after now. */
function nextRunAt(def: SlotSpec, state: ProjectTimerStateRow, nowMs: number): number | null {
  if (def.periodMs === undefined && state.lastSlotMs !== null) return null;
  const due = latestSlotAt(def, nowMs);
  if (
    due !== null &&
    slotInWindow(def, due) &&
    (state.lastSlotMs === null || due > state.lastSlotMs)
  ) {
    return due;
  }
  return nextSlotAfter(def, nowMs);
}

/** The panel's status precedence: invalid > done (one-shot) > expired > the enabled flag. */
export function timerStatusOf(
  def: SlotSpec & { enabled: boolean },
  state: ProjectTimerStateRow,
  nowMs: number,
): ProjectTimerStatus {
  if (state.invalidReason !== null) return "invalid";
  if (def.periodMs === undefined && state.lastSlotMs !== null) return "done";
  if (def.endAtMs !== undefined && nowMs > def.endAtMs) return "expired";
  return def.enabled ? "active" : "disabled";
}

function toRunRecord(row: ProjectTimerRunRow): ProjectTimerRunRecord {
  let summary: AlignmentSummary | undefined;
  if (row.summary !== null) {
    try {
      summary = JSON.parse(row.summary) as AlignmentSummary;
    } catch {
      summary = undefined; // A row written by an older shape: report the run, not a crash.
    }
  }
  return {
    runId: row.runId,
    name: row.name,
    trigger: row.trigger === "manual" ? "manual" : "schedule",
    dryRun: row.dryRun,
    startedAt: row.startedAt,
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
    status: row.status as ProjectTimerRunStatus,
    ...(summary !== undefined ? { summary } : {}),
  };
}
