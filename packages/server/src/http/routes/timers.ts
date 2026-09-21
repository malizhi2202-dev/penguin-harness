/**
 * Project alignment timer routes:
 *   GET  /api/projects/:projectId/timers              the declaration, its state and next runs
 *   PUT  /api/projects/:projectId/timers              replace the whole file
 *   POST /api/projects/:projectId/timers/:name/run    run one timer now (optional dry run)
 *   GET  /api/projects/:projectId/timers/:name/runs   that timer's run history
 *
 * Any member can read; only the owner can write or run — the same split as Agent schedules,
 * because a timer commits and merges in the Project's repositories. The file is declarative
 * intent: PUT replaces it whole, validation always goes through the same parser a hand-edited
 * file gets (there is never a second set of rules), and the write takes effect immediately via
 * reconciliation rather than at the next tick.
 */
import { Hono } from "hono";
import { isValidId } from "@prismshadow/penguin-core";
import type {
  AlignmentSummary,
  ProjectTimerItem,
  ProjectTimerRunRecord,
  ProjectTimerRunStatus,
  ProjectTimersResponse,
} from "../../api/types.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { HttpError } from "../errors.js";
import {
  badRequest,
  optionalBoolean,
  optionalPagingQuery,
  readJson,
  requireString,
  requireValidId,
} from "../validate.js";
import { parseProjectTimersFile } from "../../runtime/project-timer-file.js";
import type { ProjectTimerEntryView } from "../../runtime/project-timer-runner.js";
import { timerStatusOf } from "../../runtime/project-timer-runner.js";
import { writeProjectTimers } from "../../runtime/project-timer-store.js";
import { validateScheduleModelRef } from "../../runtime/schedule-store.js";

/** Runs one page of history asks for when the caller does not say. */
const DEFAULT_RUN_LIMIT = 20;
/** More than this in one page is a scroll nobody reads. */
const MAX_RUN_LIMIT = 100;

/** One parsed summary, or undefined when the stored JSON is not readable. */
function parseSummary(raw: string | null): AlignmentSummary | undefined {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as AlignmentSummary;
  } catch {
    return undefined;
  }
}

function toItem(entry: ProjectTimerEntryView, running: boolean, nowMs: number): ProjectTimerItem {
  const { def, state } = entry;
  const lastSummary = parseSummary(state.lastSummary);
  return {
    name: def.name,
    enabled: def.enabled,
    startAt: def.startAt,
    ...(def.period !== undefined ? { period: def.period } : {}),
    ...(def.endAt !== undefined ? { endAt: def.endAt } : {}),
    sync: def.sync,
    commit: def.commit,
    docs: def.docs,
    ...(def.agentPrompt !== undefined ? { agentPrompt: def.agentPrompt } : {}),
    ...(def.sessionId !== undefined ? { sessionId: def.sessionId } : {}),
    ...(def.workspace !== undefined ? { workspace: def.workspace } : {}),
    ...(def.modelId !== undefined ? { modelId: def.modelId } : {}),
    ...(def.provider !== undefined ? { provider: def.provider } : {}),
    status: timerStatusOf(def, state, nowMs),
    ...(state.invalidReason !== null ? { invalidReason: state.invalidReason } : {}),
    ...(entry.nextRunAt !== null ? { nextRunAt: new Date(entry.nextRunAt).toISOString() } : {}),
    ...(state.lastRunAt !== null ? { lastRunAt: state.lastRunAt } : {}),
    ...(state.lastStatus !== null ? { lastStatus: state.lastStatus as ProjectTimerRunStatus } : {}),
    ...(lastSummary !== undefined ? { lastSummary } : {}),
    running,
  };
}

/** The whole-file response both GET and PUT answer with, built one way so they cannot drift. */
async function respond(deps: AppDeps, projectId: string): Promise<ProjectTimersResponse> {
  const view = await deps.projectTimers.view(projectId);
  const nowMs = Date.now();
  return {
    file: view.file,
    timers: view.entries.map((entry) =>
      toItem(entry, deps.projectTimers.isRunning(projectId, entry.def.name), nowMs),
    ),
    errors: view.errors,
    ...(view.fileError !== undefined ? { fileError: view.fileError } : {}),
  };
}

/** Timer name in the path: same character rules as directories and schedule files. */
function requireTimerName(raw: string | undefined): string {
  if (!raw || !isValidId(raw)) throw badRequest("Invalid timer name.");
  return raw;
}

export function projectTimerRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return c.json(await respond(deps, projectId));
  });

  app.put("/", async (c) => {
    const projectId = requireValidId(c, "projectId");
    const project = deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const body = await readJson(c);
    const raw = requireString(body, "raw", { label: "raw", maxLen: 1_000_000 });
    // Validation goes through the same parser a hand-edited file gets. A file that cannot be
    // interpreted at all is refused and nothing is written. A file that parses but holds a bad
    // entry IS saved, with that entry's error returned in `errors` for the panel to show: one
    // typo in one timer must not block saving the other nine, and the runner skips exactly the
    // entry the response names.
    const parsed = parseProjectTimersFile(raw);
    if (!parsed.ok) throw badRequest(`Invalid timers file: ${parsed.error}`);
    // Model references are checked at save time too (same rules as reconciliation), so a file
    // that names a model the Project does not have is never persisted.
    for (const def of parsed.defs) {
      const refError = await validateScheduleModelRef(deps.projectConfigService, projectId, def);
      if (refError !== null) {
        throw badRequest(`Invalid timer ${def.name}: ${refError}`);
      }
    }
    await writeProjectTimers(deps.config.root, projectId, raw);
    await deps.projectTimers.reconcileProject(projectId, project.ownerUserId);
    return c.json(await respond(deps, projectId));
  });

  app.post("/:name/run", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectOwner(c.var.user.userId, projectId);
    const name = requireTimerName(c.req.param("name"));
    const body = await readJson(c);
    const dryRun = optionalBoolean(body, "dryRun") === true;
    if (deps.projectTimers.isRunning(projectId, name)) {
      throw new HttpError(409, "timer_running", `Timer is already running: ${name}`);
    }
    const view = await deps.projectTimers.view(projectId);
    if (!view.entries.some((entry) => entry.def.name === name)) {
      throw new HttpError(404, "timer_not_found", `Timer does not exist: ${name}`);
    }
    const result = await deps.projectTimers.runNow(projectId, name, { dryRun });
    if (result.status === "running") {
      throw new HttpError(409, "timer_running", `Timer is already running: ${name}`);
    }
    const record: ProjectTimerRunRecord = {
      runId: result.runId,
      name,
      trigger: "manual",
      dryRun,
      startedAt: new Date().toISOString(),
      status: result.status,
      ...(result.summary !== null ? { summary: result.summary } : {}),
    };
    return c.json(record);
  });

  app.get("/:name/runs", async (c) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    const name = requireTimerName(c.req.param("name"));
    const paging = optionalPagingQuery(c) ?? { offset: 0, limit: DEFAULT_RUN_LIMIT };
    const limit = Math.min(paging.limit, MAX_RUN_LIMIT);
    return c.json({ runs: deps.projectTimers.history(projectId, name, limit) });
  });

  return app;
}
