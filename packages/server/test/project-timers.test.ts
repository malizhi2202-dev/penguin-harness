/**
 * Tests for the Project timer module's own surface: the file parser (every rejection is a
 * message someone has to read), the path classification the drift checks rest on, the runner's
 * scheduling contract (no backfill, a slot consumed whatever happens, one-shot done, delete the
 * file and the state goes), the Agent hand-off, and the routes' access and validation rules.
 *
 * The runner's git work is stubbed here on purpose — the pass itself is covered against real
 * repositories in `project-alignment.test.ts`, and stubbing it is what lets these tests pin the
 * scheduling semantics instead of git's.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AlignmentSummary,
  ProjectTimerServerEvent,
  ProjectTimersResponse,
} from "../src/api/types.js";
import { ProjectTimersRepo } from "../src/db/repos/project-timers.js";
import { ProjectsRepo } from "../src/db/repos/projects.js";
import {
  PROJECT_TIMERS_TEMPLATE,
  parseProjectTimersFile,
} from "../src/runtime/project-timer-file.js";
import { ProjectTimerRunner, timerStatusOf } from "../src/runtime/project-timer-runner.js";
import { classifyPath } from "../src/services/project-alignment.js";
import { apiClient, createTestApp, loginAdmin, provisionUser, waitFor } from "./helpers.js";
import type { TestApp } from "./helpers.js";

/** A fixed instant: 2026-09-22T01:00:00Z. */
const NOW = Date.parse("2026-09-22T01:00:00.000Z");

function emptySummary(overrides: Partial<AlignmentSummary> = {}): AlignmentSummary {
  return {
    at: new Date(NOW).toISOString(),
    sync: "fetch",
    commit: "off",
    dryRun: false,
    repos: [],
    counts: { repos: 0, findings: 0, attention: 0, merged: 0, committed: 0, failed: 0 },
    ...overrides,
  };
}

function withAttention(): AlignmentSummary {
  return emptySummary({
    repos: [
      {
        path: "/tmp/repo",
        root: "/tmp/repo",
        name: "repo",
        branch: "dev",
        upstream: "origin/dev",
        ahead: 1,
        behind: 0,
        actions: ["fetched"],
        findings: [
          {
            kind: "code_without_docs",
            severity: "attention",
            detail: "2 code file(s) changed and no document did.",
            files: ["src/a.ts"],
          },
        ],
        changed: { code: 2, docs: 0 },
        merged: 0,
        committed: 0,
      },
    ],
    counts: { repos: 1, findings: 1, attention: 1, merged: 0, committed: 0, failed: 0 },
  });
}

describe("parseProjectTimersFile", () => {
  it("reads a full timer and applies the documented defaults", () => {
    const result = parseProjectTimersFile(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T09:00:00+08:00"
period = "1h"
sync = "fast-forward"
commit = "auto"
docs = false
agent_prompt = "fix the docs"
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.errors).toEqual([]);
    const def = result.defs[0]!;
    expect(def.name).toBe("git-align");
    expect(def.enabled).toBe(true);
    expect(def.periodMs).toBe(3_600_000);
    expect(def.sync).toBe("fast-forward");
    expect(def.commit).toBe("auto");
    expect(def.docs).toBe(false);
    expect(def.agentPrompt).toBe("fix the docs");
    expect(def.startAtMs).toBe(Date.parse("2026-09-22T09:00:00+08:00"));
  });

  it("defaults to the safe end of every knob", () => {
    const result = parseProjectTimersFile(`
[[timer]]
name = "git-align"
start_at = "2026-09-22T09:00:00Z"
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const def = result.defs[0]!;
    // Disabled, fetch-only, no commit, drift checks on: a hand-written stub changes nothing.
    expect(def.enabled).toBe(false);
    expect(def.sync).toBe("fetch");
    expect(def.commit).toBe("off");
    expect(def.docs).toBe(true);
    expect(def.periodMs).toBeUndefined();
  });

  it("ships a template that actually parses", () => {
    const result = parseProjectTimersFile(PROJECT_TIMERS_TEMPLATE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.errors).toEqual([]);
    expect(result.defs.map((d) => d.name)).toEqual(["git-align"]);
    // The template's whole point is that turning the timer on is one edit.
    expect(result.defs[0]!.enabled).toBe(false);
    expect(result.defs[0]!.commit).toBe("auto");
  });

  it("reports a bad entry by name and keeps its neighbours", () => {
    const result = parseProjectTimersFile(`
[[timer]]
name = "good"
start_at = "2026-09-22T09:00:00Z"

[[timer]]
name = "bad"
start_at = "not a date"

[[timer]]
name = "good"
start_at = "2026-09-22T09:00:00Z"
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.defs.map((d) => d.name)).toEqual(["good"]);
    expect(result.errors).toEqual([
      { name: "bad", error: "start_at is missing or not a valid ISO 8601 instant" },
      { name: "good", error: "duplicate timer name" },
    ]);
  });

  it("rejects each field with a message that names it", () => {
    const cases: Array<[string, string]> = [
      [`name = "Bad Name"\nstart_at = "2026-09-22T09:00:00Z"`, "name must be a lowercase id"],
      [
        `name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nperiod = "1m"`,
        "period is below the 5m minimum",
      ],
      [`name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nperiod = "soon"`, "period must look like"],
      [`name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nsync = "rebase"`, "sync must be one of"],
      [`name = "t"\nstart_at = "2026-09-22T09:00:00Z"\ncommit = "yes"`, "commit must be one of"],
      [
        `name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nend_at = "2026-09-21T09:00:00Z"`,
        "end_at must be later than start_at",
      ],
      [
        `name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nmodel_id = "gpt"\nagent_prompt = "x"`,
        "provider and model_id must be given together",
      ],
      [
        `name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nsession_id = "session-1"`,
        "only mean something together with agent_prompt",
      ],
      [
        `name = "t"\nstart_at = "2026-09-22T09:00:00Z"\nsession_id = "s"\nworkspace = "/tmp"\nagent_prompt = "x"`,
        "Pick one target",
      ],
    ];
    for (const [body, expected] of cases) {
      const result = parseProjectTimersFile(`[[timer]]\n${body}\n`);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.defs).toEqual([]);
      expect(result.errors[0]?.error).toContain(expected);
    }
  });

  it("rejects a file it cannot use at all", () => {
    expect(parseProjectTimersFile("not toml = =")).toMatchObject({ ok: false });
    expect(parseProjectTimersFile("timer = 3")).toEqual({
      ok: false,
      error: "timer must be an array of tables ([[timer]])",
    });
    // No timers at all is a valid, empty file.
    expect(parseProjectTimersFile("# nothing here\n")).toEqual({ ok: true, defs: [], errors: [] });
  });
});

describe("classifyPath", () => {
  it("splits documents, code and the changes that say nothing about drift", () => {
    expect(classifyPath("README.md")).toBe("doc");
    expect(classifyPath("docs/guide/index.mdx")).toBe("doc");
    expect(classifyPath("changelog/unreleased/2026-09-22-x.md")).toBe("doc");
    expect(classifyPath(".agents/skills/dev/SKILL.md")).toBe("doc");
    expect(classifyPath("packages/server/src/app.ts")).toBe("code");
    expect(classifyPath("pnpm-lock.yaml")).toBe("noise");
    expect(classifyPath("packages/web/dist/index.js")).toBe("noise");
    expect(classifyPath("node_modules/x/y.js")).toBe("noise");
  });
});

describe("project timer runner", () => {
  let t: TestApp;
  let runner: ProjectTimerRunner;
  let repo: ProjectTimersRepo;
  let projectId: string;
  /** The runner's clock, moved by hand: every scheduling claim here is about time passing. */
  let nowMs: number;
  let alignment: AlignmentSummary;
  let alignmentCalls: number;
  const events: ProjectTimerServerEvent[] = [];
  const started: string[] = [];
  const created: Array<{ agentId: string; source?: string }> = [];

  const at = (iso: string): number => Date.parse(iso);

  beforeEach(async () => {
    t = await createTestApp();
    projectId = "default_project";
    repo = new ProjectTimersRepo(t.deps.db);
    nowMs = NOW;
    alignment = emptySummary();
    alignmentCalls = 0;
    events.length = 0;
    started.length = 0;
    created.length = 0;
    runner = new ProjectTimerRunner({
      root: t.root,
      repo,
      projects: new ProjectsRepo(t.deps.db),
      sessions: t.deps.sessionsRepo,
      runner: {
        statusOf: () => "idle",
        startTask: async (sessionId) => {
          started.push(sessionId);
          return { sessionId };
        },
      },
      sessionCreator: {
        createSession: async (args) => {
          created.push({ agentId: args.agentId, source: args.source });
          return { sessionId: "session-handed-off" };
        },
      },
      projectConfig: t.deps.projectConfigService,
      errors: t.deps.errors,
      notify: (_userId, event) => events.push(event),
      now: () => nowMs,
      alignment: async () => {
        alignmentCalls += 1;
        return alignment;
      },
    });
  });

  afterEach(async () => {
    await t.cleanup();
  });

  async function writeTimers(raw: string): Promise<void> {
    const dir = path.join(t.root, projectId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "timers.toml"), raw, "utf8");
  }

  it("runs a due timer, consumes the slot, and records the run", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T00:00:00Z"
period = "30m"
`);
    // First sight of the timer consumes the slot already due at that instant: nothing replays.
    await runner.tickOnce();
    expect(alignmentCalls).toBe(0);
    expect(repo.find(projectId, "git-align")?.lastSlotMs).toBe(at("2026-09-22T01:00:00Z"));

    nowMs = at("2026-09-22T01:30:00Z");
    await runner.tickOnce();
    expect(alignmentCalls).toBe(1);
    const state = repo.find(projectId, "git-align");
    expect(state?.lastSlotMs).toBe(at("2026-09-22T01:30:00Z"));
    expect(state?.lastStatus).toBe("ok");
    expect(JSON.parse(state!.lastSummary!)).toMatchObject({ counts: { repos: 0 } });
    expect(events.map((e) => e.type)).toEqual(["project_timer_ran"]);
    expect(events[0]).toMatchObject({ name: "git-align", status: "ok", handedOff: false });
    expect(runner.history(projectId, "git-align", 10)[0]).toMatchObject({
      status: "ok",
      trigger: "schedule",
      dryRun: false,
    });

    // A second tick inside the same slot does nothing: the slot is consumed, not retried.
    await runner.tickOnce();
    expect(alignmentCalls).toBe(1);
  });

  it("does not backfill the slots that passed before the timer was first seen", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-01T00:00:00Z"
period = "30m"
`);
    await runner.tickOnce();

    // Three weeks of missed slots collapse into one marker at "now": no replay, no run, and the
    // next fire is the next slot after it.
    expect(alignmentCalls).toBe(0);
    const state = repo.find(projectId, "git-align");
    expect(state?.lastSlotMs).toBe(at("2026-09-22T01:00:00Z"));
    expect(state?.lastRunAt).toBeNull();
    const view = await runner.view(projectId);
    expect(view.entries[0]!.nextRunAt).toBe(at("2026-09-22T01:30:00Z"));
    expect(timerStatusOf(view.entries[0]!.def, view.entries[0]!.state, nowMs)).toBe("active");
  });

  it("skips a disabled timer, and runs a one-shot exactly once", async () => {
    await writeTimers(`
[[timer]]
name = "off"
enabled = false
start_at = "2026-09-22T00:00:00Z"
period = "30m"

[[timer]]
name = "once"
enabled = true
start_at = "2026-09-22T01:30:00Z"
`);
    await runner.tickOnce();
    expect(alignmentCalls).toBe(0);
    expect(repo.find(projectId, "off")?.lastRunAt).toBeNull();

    nowMs = at("2026-09-22T01:30:00Z");
    await runner.tickOnce();
    expect(alignmentCalls).toBe(1);
    expect(repo.find(projectId, "once")?.lastStatus).toBe("ok");

    // Past its single slot, the timer is done: no second run, and no next time to show.
    nowMs = at("2026-09-22T02:30:00Z");
    await runner.tickOnce();
    expect(alignmentCalls).toBe(1);
    const once = (await runner.view(projectId)).entries.find((e) => e.def.name === "once")!;
    expect(once.nextRunAt).toBeNull();
    expect(timerStatusOf(once.def, once.state, nowMs)).toBe("done");
  });

  it("hands attention findings to a Session, and stays quiet when there are none", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T01:30:00Z"
period = "30m"
agent_prompt = "Align the docs with the code."
`);
    // Registering before the slot is what lets it fire: a timer first seen at its own slot time
    // would consume that slot (the no-backfill rule above) and wait for the next one.
    await runner.tickOnce();
    expect(alignmentCalls).toBe(0);

    alignment = withAttention();
    nowMs = at("2026-09-22T01:30:00Z");
    await runner.tickOnce();
    expect(created).toEqual([{ agentId: "default_agent", source: "schedule" }]);
    expect(started).toEqual(["session-handed-off"]);
    expect(events[0]).toMatchObject({ status: "drift", attention: 1, handedOff: true });

    // Nothing worth attention: the pass still runs and is reported, but no Prompt is sent.
    started.length = 0;
    created.length = 0;
    alignment = emptySummary();
    nowMs = at("2026-09-22T02:00:00Z");
    await runner.tickOnce();
    expect(alignmentCalls).toBe(2);
    expect(started).toEqual([]);
    expect(events.at(-1)).toMatchObject({ status: "ok", handedOff: false });
  });

  it("forgets a timer whose file entry is gone, history included", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T01:30:00Z"
period = "30m"
`);
    await runner.tickOnce();
    nowMs = at("2026-09-22T01:30:00Z");
    await runner.tickOnce();
    expect(repo.find(projectId, "git-align")).not.toBeNull();
    expect(runner.history(projectId, "git-align", 10)).toHaveLength(1);

    await writeTimers("# all timers removed\n");
    await runner.tickOnce();
    expect(repo.find(projectId, "git-align")).toBeNull();
    expect(runner.history(projectId, "git-align", 10)).toEqual([]);

    // Deleting the file entirely is the same statement, and must not throw.
    await fs.rm(path.join(t.root, projectId, "timers.toml"));
    await runner.tickOnce();
    expect(repo.listByProject(projectId)).toEqual([]);
  });

  it("shows a timer whose model reference does not resolve as invalid, and never runs it", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T01:30:00Z"
period = "30m"
agent_prompt = "Align things."
provider = "openai"
model_id = "no-such-model"
`);
    const entry = (await runner.view(projectId)).entries[0]!;
    expect(entry.state.invalidReason).toBeTruthy();
    expect(timerStatusOf(entry.def, entry.state, nowMs)).toBe("invalid");
    // Disabled-by-invalid is a view, not a stored edit: only the config needs fixing.
    expect(entry.nextRunAt).toBeNull();
    expect(repo.find(projectId, "git-align")).toBeNull();

    nowMs = at("2026-09-22T01:30:00Z");
    await runner.tickOnce();
    expect(alignmentCalls).toBe(0);
    expect(runner.history(projectId, "git-align", 5)).toEqual([]);
  });

  it("relabels the runs a dead process left open instead of calling them running", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T01:30:00Z"
`);
    // A run row with no finish time is what a crash between startRun and finishRun leaves.
    repo.startRun({
      runId: "run-orphan",
      projectId,
      name: "git-align",
      trigger: "schedule",
      dryRun: false,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(runner.history(projectId, "git-align", 5)[0]).toMatchObject({ status: "running" });

    // start() is what a booting server does first, and the relabel is the part it awaits —
    // the first pass runs in the background so a slow remote cannot hold up the boot.
    await runner.start();
    runner.stop();
    const orphan = runner.history(projectId, "git-align", 5)[0]!;
    expect(orphan.status).toBe("interrupted");
    expect(orphan.finishedAt).toBeDefined();
    // The timer's own state is the last run that FINISHED: a crashed attempt only ever appears
    // in the history, and must not be laundered into the state as an outcome.
    await runner.reconcileProject(projectId, null);
    expect(repo.find(projectId, "git-align")?.lastStatus).toBeNull();
  });

  it("refuses to overlap two passes of the same timer", async () => {
    await writeTimers(`
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T01:30:00Z"
`);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ProjectTimerRunner({
      root: t.root,
      repo,
      projects: new ProjectsRepo(t.deps.db),
      sessions: t.deps.sessionsRepo,
      runner: { statusOf: () => "idle", startTask: async (s) => ({ sessionId: s }) },
      sessionCreator: { createSession: async () => ({ sessionId: "s" }) },
      projectConfig: t.deps.projectConfigService,
      errors: t.deps.errors,
      notify: () => {},
      now: () => nowMs,
      alignment: async () => {
        await gate;
        return emptySummary();
      },
    });
    await slow.tickOnce();
    nowMs = at("2026-09-22T01:30:00Z");
    const first = slow.tickOnce();
    await waitFor(() => slow.isRunning(projectId, "git-align"));
    // A manual run while the pass is in flight is refused rather than raced.
    expect(await slow.runNow(projectId, "git-align", { dryRun: false })).toMatchObject({
      status: "running",
    });
    release();
    await first;
    expect(slow.isRunning(projectId, "git-align")).toBe(false);
  });
});

describe("project timer api", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  const projectId = "default_project";

  const url = (suffix = "") => `/api/projects/${projectId}/timers${suffix}`;

  beforeEach(async () => {
    t = await createTestApp();
    owner = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    outsider = apiClient(t.app, (await provisionUser(t.app, "outsider_t")).cookie);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("reports a Project that declares no timers, and writes one whole", async () => {
    const empty = await owner.get(url());
    expect(empty.status).toBe(200);
    expect((await empty.json()) as ProjectTimersResponse).toMatchObject({
      file: { exists: false, raw: "" },
      timers: [],
    });

    const raw = `
[[timer]]
name = "git-align"
enabled = true
start_at = "2026-09-22T00:00:00Z"
period = "30m"
sync = "fast-forward"
commit = "auto"
`;
    const put = await owner.put(url(), { raw });
    expect(put.status).toBe(200);
    const body = (await put.json()) as ProjectTimersResponse;
    expect(body.file.exists).toBe(true);
    expect(body.timers).toHaveLength(1);
    expect(body.timers[0]).toMatchObject({
      name: "git-align",
      enabled: true,
      sync: "fast-forward",
      commit: "auto",
      docs: true,
      status: "active",
      running: false,
    });
    expect(body.timers[0]!.nextRunAt).toBeDefined();
    // The write landed on disk as the whole file, not appended to anything.
    expect(body.file.raw).toBe(raw);
  });

  it("refuses a file it cannot interpret, and never persists it", async () => {
    expect((await owner.put(url(), { raw: "timer = 3" })).status).toBe(400);
    expect((await owner.put(url(), { raw: "not toml = =" })).status).toBe(400);
    const after = await owner.get(url());
    expect(((await after.json()) as ProjectTimersResponse).file.exists).toBe(false);
  });

  it("saves a file with one bad entry, and reports that entry instead of the whole file", async () => {
    const raw = `
[[timer]]
name = "good"
enabled = true
start_at = "2026-09-22T00:00:00Z"
period = "30m"

[[timer]]
name = "bad"
start_at = "whenever"
`;
    const put = await owner.put(url(), { raw });
    // One typo must not cost the other timers their save: the file is kept, the entry is named.
    expect(put.status).toBe(200);
    const body = (await put.json()) as ProjectTimersResponse;
    expect(body.timers.map((timer) => timer.name)).toEqual(["good"]);
    expect(body.errors).toEqual([
      { name: "bad", error: "start_at is missing or not a valid ISO 8601 instant" },
    ]);
  });

  it("keeps an outsider out of both the read and the write", async () => {
    expect((await outsider.get(url())).status).toBe(404);
    expect((await outsider.put(url(), { raw: "" })).status).toBe(404);
  });

  it("runs a timer on demand, dry, and lists what it did", async () => {
    await owner.put(url(), {
      raw: '[[timer]]\nname = "git-align"\nenabled = true\nstart_at = "2026-09-22T00:00:00Z"\n',
    });
    const run = await owner.post(url("/git-align/run"), { dryRun: true });
    expect(run.status).toBe(200);
    const record = (await run.json()) as { status: string; dryRun: boolean; runId: string };
    expect(record.dryRun).toBe(true);
    // The default Project has no Session Workspaces, so there is no repository to pass over.
    expect(record.status).toBe("ok");
    expect(record.runId).toMatch(/^run-/);

    const runs = await owner.get(url("/git-align/runs"));
    expect(runs.status).toBe(200);
    const listed = (await runs.json()) as { runs: Array<{ runId: string; trigger: string }> };
    expect(listed.runs.map((r) => r.runId)).toContain(record.runId);
    expect(listed.runs[0]!.trigger).toBe("manual");

    // An unknown timer is a 404 for a run, and an empty history for a list.
    expect((await owner.post(url("/nope/run"), {})).status).toBe(404);
    expect(
      ((await (await owner.get(url("/nope/runs"))).json()) as { runs: unknown[] }).runs,
    ).toEqual([]);
  });
});
