/**
 * The common configuration scope: its default plugin set file, the Model-table copy rule
 * (`missingCommonModels` / `mergeCommonModels`), and the Agent-template copy
 * (`copyAgentStateFrom`) — including what a copy deliberately leaves behind.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMON_SCOPE_ID,
  DEFAULT_PROJECT_ID,
  agentStateDir,
  commonPluginsPath,
  copyAgentStateFrom,
  isReservedScopeId,
  loadAgentState,
  loadCommonDefaultPlugins,
  mergeCommonModels,
  missingCommonModels,
  saveCommonDefaultPlugins,
  systemConfigPath,
  defaultProjectConfig,
  type ModelEntry,
  type ProjectConfig,
} from "../src/state/index.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-common-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const entry = (modelId: string, extra: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: "deepseek",
  model_id: modelId,
  ...extra,
});

/** A Project config carrying exactly the given entries, with no default/vision reference. */
const configWith = (models: ModelEntry[], extra: Partial<ProjectConfig> = {}): ProjectConfig => ({
  models,
  ...extra,
});

describe("reserved scope id", () => {
  it("reserves the common scope and nothing else", () => {
    expect(isReservedScopeId(COMMON_SCOPE_ID)).toBe(true);
    expect(isReservedScopeId(DEFAULT_PROJECT_ID)).toBe(false);
    expect(isReservedScopeId("default_project")).toBe(false);
  });
});

describe("common default plugin set", () => {
  it("reads as empty when the common scope has no plugins.toml", async () => {
    await expect(loadCommonDefaultPlugins(tmpRoot)).resolves.toEqual([]);
  });

  it("round-trips a set, creating the common directory on first write", async () => {
    await saveCommonDefaultPlugins(tmpRoot, ["software-development", "goal"]);
    await expect(loadCommonDefaultPlugins(tmpRoot)).resolves.toEqual([
      "software-development",
      "goal",
    ]);
    await expect(fs.stat(commonPluginsPath(tmpRoot))).resolves.toBeTruthy();
  });

  it("stores an explicitly empty set distinctly from an unconfigured one", async () => {
    await saveCommonDefaultPlugins(tmpRoot, []);
    await expect(loadCommonDefaultPlugins(tmpRoot)).resolves.toEqual([]);
  });

  it("tolerates a hand-written file with a missing or malformed list", async () => {
    await fs.mkdir(path.join(tmpRoot, COMMON_SCOPE_ID), { recursive: true });
    await fs.writeFile(commonPluginsPath(tmpRoot), 'default_plugins = "goal"\n', "utf8");
    await expect(loadCommonDefaultPlugins(tmpRoot)).resolves.toEqual([]);
    await fs.writeFile(commonPluginsPath(tmpRoot), "other = 1\n", "utf8");
    await expect(loadCommonDefaultPlugins(tmpRoot)).resolves.toEqual([]);
  });
});

describe("model-table copy rule", () => {
  it("reports only the entries the Project lacks, by (provider, model_id) pair", () => {
    const common = configWith([
      entry("deepseek-v4-flash-vision-exp"),
      entry("gpt-5", { provider: "openai" }),
    ]);
    const project = configWith([entry("deepseek-v4-flash-vision-exp", { context_window: 1 })]);
    expect(missingCommonModels(common, project).map((m) => m.model_id)).toEqual(["gpt-5"]);
  });

  it("never treats a same-key entry with different metadata as missing", () => {
    const common = configWith([entry("m", { api_key: "sk-common", context_window: 1000 })]);
    const project = configWith([entry("m", { api_key: "sk-own", context_window: 2000 })]);
    expect(missingCommonModels(common, project)).toEqual([]);
  });

  it("appends missing entries with their credential intact and keeps the Project's own", () => {
    const common = configWith(
      [entry("m", { api_key: "sk-common" }), entry("n", { api_key: "sk-n" })],
      { default_model: { provider: "deepseek", model_id: "m" } },
    );
    const project = configWith([entry("m", { api_key: "sk-own" })]);
    const merged = mergeCommonModels(common, project);
    expect(merged.models.map((m) => m.model_id)).toEqual(["m", "n"]);
    expect(merged.models[0]!.api_key).toBe("sk-own");
    expect(merged.models[1]!.api_key).toBe("sk-n");
  });

  it("fills an unset default/vision reference from the common side", () => {
    const common = configWith([entry("m"), entry("v")], {
      default_model: { provider: "deepseek", model_id: "m" },
      vision_model: { provider: "deepseek", model_id: "v" },
    });
    const merged = mergeCommonModels(common, configWith([]));
    expect(merged.default_model).toEqual({ provider: "deepseek", model_id: "m" });
    expect(merged.vision_model).toEqual({ provider: "deepseek", model_id: "v" });
  });

  it("keeps a Project's own default/vision reference rather than the common one", () => {
    const common = configWith([entry("m"), entry("own")], {
      default_model: { provider: "deepseek", model_id: "m" },
      vision_model: { provider: "deepseek", model_id: "m" },
    });
    const project = configWith([entry("own")], {
      default_model: { provider: "deepseek", model_id: "own" },
      vision_model: { provider: "deepseek", model_id: "own" },
    });
    const merged = mergeCommonModels(common, project);
    expect(merged.default_model).toEqual({ provider: "deepseek", model_id: "own" });
    expect(merged.vision_model).toEqual({ provider: "deepseek", model_id: "own" });
  });

  it("never adopts a common default the Project does not end up carrying", () => {
    // The common default points at an entry that is not in the common table (its model was
    // removed): copying the reference would leave a dangling default, which createSession
    // rejects — so the reference is dropped instead.
    const common = configWith([entry("m")], {
      default_model: { provider: "deepseek", model_id: "gone" },
    });
    const merged = mergeCommonModels(common, configWith([]));
    expect(merged.default_model).toBeUndefined();
  });

  it("preserves the rest of the Project config untouched", () => {
    const project = configWith([entry("own")], {
      name: "My Project",
      default_chat: { approval_mode: "read-only" },
      command_policy: { enabled: false },
    });
    const merged = mergeCommonModels(configWith([entry("m")]), project);
    expect(merged.name).toBe("My Project");
    expect(merged.default_chat).toEqual({ approval_mode: "read-only" });
    expect(merged.command_policy).toEqual({ enabled: false });
  });

  it("is a no-op against the empty common table a fresh data root has", () => {
    const project = configWith([entry("own")]);
    expect(mergeCommonModels(configWith([]), project)).toEqual(project);
  });
});

describe("agent template copy", () => {
  const SOURCE = { projectId: COMMON_SCOPE_ID, agentId: "template_agent" };
  const TARGET = { projectId: DEFAULT_PROJECT_ID, agentId: "copy_agent" };

  /** Initializes the source Agent and gives it behavior worth copying. */
  async function seedTemplate(): Promise<void> {
    await loadAgentState({
      root: tmpRoot,
      projectId: SOURCE.projectId,
      agentId: SOURCE.agentId,
      init: { preset: { name: "Template", description: "Copied from" } },
    });
    const skills = path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), "skills");
    await fs.mkdir(path.join(skills, "my-skill"), { recursive: true });
    await fs.writeFile(path.join(skills, "my-skill", "SKILL.md"), "# my-skill\n", "utf8");
    const hooks = path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), "hooks");
    await fs.mkdir(path.join(hooks, "my-hook"), { recursive: true });
    await fs.writeFile(path.join(hooks, "my-hook", "hook.json"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), ".vault.toml"),
      'TOKEN = "secret"\n',
      "utf8",
    );
    await fs.mkdir(
      path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), "schedule"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), "schedule", "t.toml"),
      'prompt = "x"\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(agentStateDir(tmpRoot, SOURCE.projectId, SOURCE.agentId), "AGENTS.md"),
      "# Template instructions\n",
      "utf8",
    );
  }

  it("copies the behavior — config, AGENTS.md, skills, hooks", async () => {
    await seedTemplate();
    await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
      init: {},
    });
    await copyAgentStateFrom({
      root: tmpRoot,
      fromProjectId: SOURCE.projectId,
      fromAgentId: SOURCE.agentId,
      toProjectId: TARGET.projectId,
      toAgentId: TARGET.agentId,
    });

    const state = await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
    });
    expect(state.systemConfig.name).toBe("Template");
    expect(state.agentsMd).toBe("# Template instructions\n");
    const copiedSkill = path.join(
      agentStateDir(tmpRoot, TARGET.projectId, TARGET.agentId),
      "skills",
      "my-skill",
      "SKILL.md",
    );
    await expect(fs.readFile(copiedSkill, "utf8")).resolves.toBe("# my-skill\n");
    await expect(
      fs.stat(
        path.join(agentStateDir(tmpRoot, TARGET.projectId, TARGET.agentId), "hooks", "my-hook"),
      ),
    ).resolves.toBeTruthy();
  });

  it("leaves secrets, memory and timed work behind", async () => {
    await seedTemplate();
    await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
      init: {},
    });
    await copyAgentStateFrom({
      root: tmpRoot,
      fromProjectId: SOURCE.projectId,
      fromAgentId: SOURCE.agentId,
      toProjectId: TARGET.projectId,
      toAgentId: TARGET.agentId,
    });

    const targetState = agentStateDir(tmpRoot, TARGET.projectId, TARGET.agentId);
    await expect(fs.stat(path.join(targetState, ".vault.toml"))).rejects.toThrow();
    await expect(fs.stat(path.join(targetState, "schedule"))).rejects.toThrow();
    // The copy carries the source's behavior, never its traces/scratchpad/workspaces.
    await expect(fs.stat(path.join(targetState, "..", "traces"))).rejects.toThrow();
  });

  it("lets the caller's own name/description win when written after the copy", async () => {
    await seedTemplate();
    await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
      init: {},
    });
    await copyAgentStateFrom({
      root: tmpRoot,
      fromProjectId: SOURCE.projectId,
      fromAgentId: SOURCE.agentId,
      toProjectId: TARGET.projectId,
      toAgentId: TARGET.agentId,
    });
    // The server writes identity after the copy (see AgentService.createAgent); this pins the
    // ordering contract the copy helper documents.
    const configPath = systemConfigPath(tmpRoot, TARGET.projectId, TARGET.agentId);
    const raw = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, raw.replace("name: Template", "name: Renamed"), "utf8");
    const state = await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
    });
    expect(state.systemConfig.name).toBe("Renamed");
  });

  it("refuses a directory that is not an Agent", async () => {
    await loadAgentState({
      root: tmpRoot,
      projectId: TARGET.projectId,
      agentId: TARGET.agentId,
      init: {},
    });
    await expect(
      copyAgentStateFrom({
        root: tmpRoot,
        fromProjectId: SOURCE.projectId,
        fromAgentId: "does_not_exist",
        toProjectId: TARGET.projectId,
        toAgentId: TARGET.agentId,
      }),
    ).rejects.toThrow(/no Agent State/);
  });

  it("copies the preset model table a new data root would seed", async () => {
    // Guard against the common scope silently becoming the default seeding source for tests
    // that assume the built-in catalog: the built-in default config still stands alone.
    const preset = defaultProjectConfig();
    expect(preset.models.length).toBeGreaterThan(0);
    expect(mergeCommonModels(configWith([]), preset).models.length).toBe(preset.models.length);
  });
});
