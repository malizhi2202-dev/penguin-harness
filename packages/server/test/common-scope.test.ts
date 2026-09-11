/**
 * The common configuration scope (`<root>/common/`) as the server exposes it:
 *
 * - the reserved id is not a Project (uncreatable, unrenamable, undeletable, no Sessions),
 * - it is admin-only through the ordinary Project routes, while the two surfaces a member
 *   genuinely needs (the default plugin set, the template listing) have their own reads,
 * - and its two copy rules: a new Project is seeded with the common Model table, an Agent can be
 *   created from a common template and/or the common default plugin set — copies that never link
 *   back.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMON_SCOPE_ID,
  agentStateDir,
  loadAgentState,
  loadLibraryPlugins,
  systemConfigPath,
} from "@prismshadow/penguin-core";
import type {
  AgentCreateResponse,
  AgentsResponse,
  CommonAgentTemplatesResponse,
  CommonModelImportResult,
  CommonPluginsResponse,
  ModelsResponse,
  ProjectCreateResponse,
} from "../src/api/types.js";
import { apiClient, createTestApp, loginAdmin, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";
import { ProjectsRepo } from "../src/db/repos/projects.js";
import { ProjectConfigService } from "../src/services/project-config-service.js";

/** `<provider>\0<model_id>` — the (provider, model_id) pair as a comparable key. */
const pairKey = (m: { provider: string; modelId: string }): string => `${m.provider}\0${m.modelId}`;

/** The common Model table a test data root starts with. */
const COMMON_MODELS = {
  name: "Common",
  default_model: { provider: "deepseek", model_id: "common-default" },
  models: [
    { provider: "deepseek", model_id: "common-default", api_key: "sk-common" },
    { provider: "openai", model_id: "common-extra" },
  ],
};

/**
 * The Model table of the colliding-Project fixture: a real preset model (so a Session can
 * actually start on it) carrying a credential no preset has, which is what makes "did this
 * Project's table leak into a new Project" answerable on disk.
 */
const LEGACY_MODELS = {
  default_model: { provider: "deepseek", model_id: "deepseek-v4-flash-vision-exp" },
  models: [
    { provider: "deepseek", model_id: "deepseek-v4-flash-vision-exp", api_key: "sk-legacy" },
  ],
};

/** A library plugin name that exists in whatever library this build ships. */
function aLibraryPluginName(): string {
  const plugin = loadLibraryPlugins()[0];
  if (plugin === undefined) throw new Error("The built-in plugin library is empty.");
  return plugin.name;
}

describe("common scope: reserved id and access", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;
  let member: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp({
      beforeSeed: async (root) => {
        await new ProjectConfigService(root).writeRaw(COMMON_SCOPE_ID, COMMON_MODELS);
      },
    });
    admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    member = apiClient(t.app, (await provisionUser(t.app, "plain_member")).cookie);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("is not listed as a Project", async () => {
    const res = await admin.get("/api/projects");
    const body = (await res.json()) as { projects: Array<{ projectId: string }> };
    expect(body.projects.map((p) => p.projectId)).not.toContain(COMMON_SCOPE_ID);
  });

  it("cannot be created, renamed or deleted as a Project", async () => {
    const create = await admin.post("/api/projects", { projectId: COMMON_SCOPE_ID });
    expect(create.status).toBe(400);
    expect(((await create.json()) as { error: { code: string } }).error.code).toBe(
      "reserved_project_id",
    );
    const rename = await admin.patch(`/api/projects/${COMMON_SCOPE_ID}`, { name: "Nope" });
    expect(rename.status).toBe(400);
    const drop = await admin.delete(`/api/projects/${COMMON_SCOPE_ID}`);
    expect(drop.status).toBe(400);
    // The refusal must be a refusal, not a late failure: the scope's own files are still there.
    await expect(
      fs.readFile(path.join(t.root, COMMON_SCOPE_ID, ".project_config.toml"), "utf8"),
    ).resolves.toContain("common-default");
  });

  it("resolves to admin-only through the ordinary Project routes", async () => {
    expect((await admin.get(`/api/projects/${COMMON_SCOPE_ID}/models`)).status).toBe(200);
    expect((await admin.get(`/api/projects/${COMMON_SCOPE_ID}/agents`)).status).toBe(200);
    // A member sees exactly what an inaccessible Project gives: 404, no existence leak.
    expect((await member.get(`/api/projects/${COMMON_SCOPE_ID}/models`)).status).toBe(404);
    expect((await member.get(`/api/projects/${COMMON_SCOPE_ID}/agents`)).status).toBe(404);
    expect(
      (await member.put(`/api/projects/${COMMON_SCOPE_ID}/models`, { models: [] })).status,
    ).toBe(404);
  });

  it("refuses to start a Session there, even for an admin", async () => {
    // A template that exists, so the refusal under test is the session guard rather than the
    // "agent does not exist" check that would answer first otherwise.
    await loadAgentState({
      root: t.root,
      projectId: COMMON_SCOPE_ID,
      agentId: "runnable_looking",
      init: { preset: { name: "Template" } },
    });
    const res = await admin.post(
      `/api/projects/${COMMON_SCOPE_ID}/agents/runnable_looking/sessions`,
      {},
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "templates to copy",
    );
  });

  it("serves the default plugin set to any signed-in user and only lets an admin write it", async () => {
    const read = await member.get("/api/common/plugins");
    expect(read.status).toBe(200);
    expect(((await read.json()) as CommonPluginsResponse).defaultPlugins).toEqual([]);

    const plugin = aLibraryPluginName();
    const denied = await member.put("/api/common/plugins", { defaultPlugins: [plugin] });
    expect(denied.status).toBe(404);

    const written = await admin.put("/api/common/plugins", { defaultPlugins: [plugin] });
    expect(written.status).toBe(200);
    const body = (await written.json()) as CommonPluginsResponse;
    expect(body.defaultPlugins).toEqual([plugin]);
    expect(body.unknownPlugins).toEqual([]);
    expect((await member.get("/api/common/plugins")).status).toBe(200);
  });

  it("rejects an unknown or duplicated plugin name instead of storing a trap", async () => {
    const unknown = await admin.put("/api/common/plugins", {
      defaultPlugins: ["nope-not-a-plugin"],
    });
    expect(unknown.status).toBe(400);
    const plugin = aLibraryPluginName();
    const dupe = await admin.put("/api/common/plugins", { defaultPlugins: [plugin, plugin] });
    expect(dupe.status).toBe(400);
    // A whole-set replacement with the field missing is a client bug, not "clear the set".
    expect((await admin.put("/api/common/plugins", {})).status).toBe(400);
    // Nothing was written by any of the three refusals.
    expect(
      ((await (await admin.get("/api/common/plugins")).json()) as CommonPluginsResponse)
        .defaultPlugins,
    ).toEqual([]);
  });

  it("lists the common Agent templates to a member, without project access", async () => {
    await loadAgentState({
      root: t.root,
      projectId: COMMON_SCOPE_ID,
      agentId: "template_agent",
      init: { preset: { name: "Template", description: "Shared starting point" } },
    });
    const res = await member.get("/api/common/agent-templates");
    expect(res.status).toBe(200);
    const { templates } = (await res.json()) as CommonAgentTemplatesResponse;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      agentId: "template_agent",
      name: "Template",
      description: "Shared starting point",
    });
  });

  it("provisions the builtin General Agent as the scope's first template, once", async () => {
    // A data root nobody has configured: the scope holds nothing, so the first read provides the
    // same builtin Agent a Project is created with — the scope opens on something to edit or copy
    // rather than on an empty list.
    const first = await member.get("/api/common/agent-templates");
    expect(first.status).toBe(200);
    const seeded = ((await first.json()) as CommonAgentTemplatesResponse).templates;
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.agentId).toBe("default_agent");
    expect(seeded[0]?.name).toBe("General Agent");
    // The preset installs the library's preinstalled plugins, so the copy carries real Skills.
    expect(seeded[0]?.skillCount).toBeGreaterThan(0);
    // It is an ordinary Agent on disk — config and Skills, and none of the three things a
    // template copy deliberately leaves behind (the preset ships no vault, memory or schedules).
    await expect(
      fs.readFile(systemConfigPath(t.root, COMMON_SCOPE_ID, "default_agent"), "utf8"),
    ).resolves.toContain("General Agent");
    await expect(
      fs.stat(path.join(agentStateDir(t.root, COMMON_SCOPE_ID, "default_agent"), ".vault.toml")),
    ).rejects.toThrow();

    // Idempotent: reading again neither duplicates it nor re-initializes it. The edit proves the
    // second read does not overwrite what an administrator has made of it.
    const configPath = systemConfigPath(t.root, COMMON_SCOPE_ID, "default_agent");
    await fs.writeFile(
      configPath,
      (await fs.readFile(configPath, "utf8")).replace(/^name:.*$/m, "name: Edited"),
      "utf8",
    );
    const again = await member.get("/api/common/agent-templates");
    const listed = ((await again.json()) as CommonAgentTemplatesResponse).templates;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("Edited");
  });

  it("provisions it for the admin's own view of the scope as well", async () => {
    const res = await admin.get(`/api/projects/${COMMON_SCOPE_ID}/agents`);
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as AgentsResponse;
    expect(agents.map((a) => a.agentId)).toEqual(["default_agent"]);
  });

  it("leaves a Project alone: listing one never provisions anything into it", async () => {
    // A Project holds no Agent directory (the fixture the collision test also uses inserts the row
    // directly), so a Project-scoped listing is the honest control for "the seeding is scoped to
    // the reserved id and to nothing else".
    const projectId = "agentless_project";
    new ProjectsRepo(t.deps.db).insert({
      projectId,
      ownerUserId: "admin",
      createdAt: new Date().toISOString(),
    });
    const res = await admin.get(`/api/projects/${projectId}/agents`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AgentsResponse).agents).toEqual([]);
    await expect(fs.stat(path.join(t.root, projectId, "agents"))).rejects.toThrow();
  });
});

describe("common scope: model copies", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    t = await createTestApp({
      beforeSeed: async (root) => {
        await new ProjectConfigService(root).writeRaw(COMMON_SCOPE_ID, COMMON_MODELS);
      },
    });
    admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("seeds a new Project with a copy, default model included", async () => {
    const created = (await (
      await admin.post("/api/projects", { projectId: "seeded_project", name: "Seeded" })
    ).json()) as ProjectCreateResponse;
    const body = (await (
      await admin.get(`/api/projects/${created.project.projectId}/models`)
    ).json()) as ModelsResponse;
    expect(body.models.map(pairKey)).toEqual(["deepseek\0common-default", "openai\0common-extra"]);
    expect(body.defaultModel).toEqual({ provider: "deepseek", modelId: "common-default" });
    // The credential travelled with the copy: the seeded model is usable as-is.
    expect(
      await fs.readFile(path.join(t.root, "seeded_project", ".project_config.toml"), "utf8"),
    ).toContain("sk-common");
  });

  it("copies, so a later edit on the common side never reaches the Project", async () => {
    await admin.post("/api/projects", { projectId: "copied_project" });
    await new ProjectConfigService(t.root).writeRaw(COMMON_SCOPE_ID, {
      default_model: { provider: "deepseek", model_id: "common-later" },
      models: [{ provider: "deepseek", model_id: "common-later" }],
    });
    const body = (await (
      await admin.get("/api/projects/copied_project/models")
    ).json()) as ModelsResponse;
    expect(body.models.map(pairKey)).toEqual(["deepseek\0common-default", "openai\0common-extra"]);
    expect(body.defaultModel).toEqual({ provider: "deepseek", modelId: "common-default" });
  });

  it("imports only what the Project lacks, and never overwrites its own entry", async () => {
    await admin.post("/api/projects", { projectId: "import_project" });
    // The Project edits its copy of the common default (its own credential now), and the common
    // side gains a model afterwards.
    await admin.put("/api/projects/import_project/models", {
      models: [
        { provider: "deepseek", modelId: "common-default", apiKey: "sk-project-own" },
        { provider: "openai", modelId: "common-extra" },
      ],
      defaultModel: { provider: "deepseek", modelId: "common-default" },
    });
    await new ProjectConfigService(t.root).writeRaw(COMMON_SCOPE_ID, {
      ...COMMON_MODELS,
      models: [...COMMON_MODELS.models, { provider: "zhipu", model_id: "common-new" }],
    });

    const res = await admin.post("/api/projects/import_project/models/import-common", {});
    expect(res.status).toBe(200);
    const result = (await res.json()) as CommonModelImportResult;
    expect(result.addedCount).toBe(1);
    expect(result.added.map((r) => r.modelId)).toEqual(["common-new"]);

    const body = (await (
      await admin.get("/api/projects/import_project/models")
    ).json()) as ModelsResponse;
    // GET masks credentials by design, so the survival of the Project's own entry is pinned on
    // disk instead: its key is still there and the imported entry was appended beside it.
    expect(body.models.map(pairKey)).toEqual([
      "deepseek\0common-default",
      "openai\0common-extra",
      "zhipu\0common-new",
    ]);
    const file = await fs.readFile(
      path.join(t.root, "import_project", ".project_config.toml"),
      "utf8",
    );
    expect(file).toContain("sk-project-own");
    expect(file).not.toContain("sk-common");
  });

  it("reports a no-op import honestly when there is nothing to copy", async () => {
    await admin.post("/api/projects", { projectId: "noop_project" });
    const res = await admin.post("/api/projects/noop_project/models/import-common", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as CommonModelImportResult).addedCount).toBe(0);
  });

  it("answers 409 when the common scope carries no models at all", async () => {
    // A second app whose data root has a common scope holding no models: the honest answer is
    // "nothing to import", not an empty success.
    const empty = await createTestApp({
      beforeSeed: async (root) => {
        await new ProjectConfigService(root).writeRaw(COMMON_SCOPE_ID, { models: [] });
      },
    });
    try {
      const api = apiClient(empty.app, (await loginAdmin(empty.app)).cookie);
      await api.post("/api/projects", { projectId: "empty_common_project" });
      const res = await api.post("/api/projects/empty_common_project/models/import-common", {});
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "no_common_models",
      );
    } finally {
      await empty.cleanup();
    }
  });
});

describe("common scope: Agent copies", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;
  let projectId: string;

  beforeEach(async () => {
    t = await createTestApp({
      beforeSeed: async (root) => {
        // A template with behavior worth copying: preset name/description plus an AGENTS.md.
        await loadAgentState({
          root,
          projectId: COMMON_SCOPE_ID,
          agentId: "template_agent",
          init: { preset: { name: "Template", description: "Shared starting point" } },
        });
        await fs.writeFile(
          path.join(agentStateDir(root, COMMON_SCOPE_ID, "template_agent"), "AGENTS.md"),
          "# Template instructions\n",
          "utf8",
        );
        // A secret that must NOT travel with the copy.
        await fs.writeFile(
          path.join(agentStateDir(root, COMMON_SCOPE_ID, "template_agent"), ".vault.toml"),
          'SECRET = "do-not-copy"\n',
          "utf8",
        );
      },
    });
    admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    const created = (await (
      await admin.post("/api/projects", { projectId: "agent_project", name: "Agents" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("creates an Agent from a template as a copy — identity from the request, prompt from the template", async () => {
    const res = await admin.post(`/api/projects/${projectId}/agents`, {
      agentId: "from_template",
      name: "My Agent",
      templateAgentId: "template_agent",
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as AgentCreateResponse;
    expect(agent.agentId).toBe("from_template");
    expect(agent.name).toBe("My Agent");

    const copied = agentStateDir(t.root, projectId, "from_template");
    await expect(fs.readFile(path.join(copied, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Template instructions\n",
    );
    // The copy is independent: the template's file changes afterwards, the Agent's does not.
    await fs.writeFile(
      path.join(agentStateDir(t.root, COMMON_SCOPE_ID, "template_agent"), "AGENTS.md"),
      "# Edited later\n",
      "utf8",
    );
    await expect(fs.readFile(path.join(copied, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Template instructions\n",
    );
  });

  it("keeps the template's secrets out of the copy", async () => {
    await admin.post(`/api/projects/${projectId}/agents`, {
      agentId: "no_secrets",
      templateAgentId: "template_agent",
    });
    const copied = agentStateDir(t.root, projectId, "no_secrets");
    await expect(fs.stat(path.join(copied, ".vault.toml"))).rejects.toThrow();
    await expect(
      fs.readFile(systemConfigPath(t.root, projectId, "no_secrets"), "utf8"),
    ).resolves.toContain("name: no_secrets");
  });

  it("falls back to the Agent id for a name the caller did not give", async () => {
    const res = await admin.post(`/api/projects/${projectId}/agents`, {
      agentId: "unnamed_copy",
      templateAgentId: "template_agent",
    });
    const { agent } = (await res.json()) as AgentCreateResponse;
    // The template names itself, not its copies…
    expect(agent.name).toBe("unnamed_copy");
    // …but its description is part of the copied config and survives an absent one, so the created
    // card reports it rather than disagreeing with the Agent list a reload later.
    expect(agent.description).toBe("Shared starting point");
    const { agents } = (await (
      await admin.get(`/api/projects/${projectId}/agents`)
    ).json()) as AgentsResponse;
    expect(agents.find((a) => a.agentId === "unnamed_copy")?.description).toBe(
      "Shared starting point",
    );
  });

  it("reports a template that does not exist instead of creating an empty Agent", async () => {
    const res = await admin.post(`/api/projects/${projectId}/agents`, {
      agentId: "broken_copy",
      templateAgentId: "no_such_template",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent_not_found");
    // The failed creation left nothing behind: the id can be used again.
    await expect(fs.stat(agentStateDir(t.root, projectId, "broken_copy"))).rejects.toThrow();
  });

  it("seeds the common default plugin set when the creator picks no plugins", async () => {
    const plugin = aLibraryPluginName();
    await admin.put("/api/common/plugins", { defaultPlugins: [plugin] });

    const seeded = (await (
      await admin.post(`/api/projects/${projectId}/agents`, { agentId: "defaulted_agent" })
    ).json()) as AgentCreateResponse;
    expect(seeded.agent.skillCount).toBeGreaterThan(0);

    // An explicit empty list is a choice: no plugins, no default set.
    const bare = (await (
      await admin.post(`/api/projects/${projectId}/agents`, {
        agentId: "bare_agent",
        plugins: [],
      })
    ).json()) as AgentCreateResponse;
    expect(bare.agent.skillCount).toBe(0);
    expect(bare.agent.hookCount).toBe(0);
  });

  it("lists the created Agent alongside the Project's built-in one", async () => {
    await admin.post(`/api/projects/${projectId}/agents`, {
      agentId: "listed_copy",
      templateAgentId: "template_agent",
    });
    const { agents } = (await (
      await admin.get(`/api/projects/${projectId}/agents`)
    ).json()) as AgentsResponse;
    expect(agents.map((a) => a.agentId)).toContain("listed_copy");
  });
});

describe("common scope: absent by default", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.cleanup();
  });

  it("leaves a data root with no common/ behaving exactly as before", async () => {
    t = await createTestApp();
    const admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
    // The preset catalog seeds a new Project (not an empty table), and the default plugin set
    // reads empty rather than "configured with nothing".
    const created = (await (
      await admin.post("/api/projects", { projectId: "preset_project" })
    ).json()) as ProjectCreateResponse;
    const models = (await (
      await admin.get(`/api/projects/${created.project.projectId}/models`)
    ).json()) as ModelsResponse;
    expect(models.models.length).toBeGreaterThan(0);
    expect(
      ((await (await admin.get("/api/common/plugins")).json()) as CommonPluginsResponse)
        .defaultPlugins,
    ).toEqual([]);
    // No `common/` directory until the scope is actually read: this call is what provisions the
    // builtin General Agent the scope starts from (see the template tests), and it is the only
    // thing a data root nobody configured gets — no Project is seeded from it, the table above
    // came from the built-in presets.
    await expect(fs.stat(path.join(t.root, COMMON_SCOPE_ID))).rejects.toThrow();
    const templates = (
      (await (
        await admin.get("/api/common/agent-templates")
      ).json()) as CommonAgentTemplatesResponse
    ).templates;
    expect(templates.map((template) => template.agentId)).toEqual(["default_agent"]);
    await expect(
      fs.readFile(path.join(t.root, COMMON_SCOPE_ID, ".project_config.toml"), "utf8"),
    ).rejects.toThrow();
    // An Agent created without plugins keeps the pre-existing behavior: no seeding.
    const agent = (await (
      await admin.post(`/api/projects/${created.project.projectId}/agents`, {
        agentId: "plain_agent",
      })
    ).json()) as AgentCreateResponse;
    expect(agent.agent.skillCount).toBe(0);
  });
});

describe("common scope: session route shape", () => {
  let t: TestApp;
  afterEach(async () => {
    await t.cleanup();
  });

  it("refuses a member's session POST in the reserved scope the same way an inaccessible Project does", async () => {
    t = await createTestApp();
    // The 404 is the access rule, not the session guard: a member never reaches the service at
    // all. The admin case above pins the guard itself (400, "templates to copy").
    const member = apiClient(t.app, (await provisionUser(t.app, "sess_member")).cookie);
    const res = await member.post(
      `/api/projects/${COMMON_SCOPE_ID}/agents/default_agent/sessions`,
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe("common scope: an existing Project on the reserved id", () => {
  let t: TestApp;
  let admin: ReturnType<typeof apiClient>;

  beforeEach(async () => {
    // The data root of an installation that predates the common scope: a real Project whose id
    // is `common`, sharing the very directory the scope would use. Creation refuses the id now,
    // so the row goes in directly — which is exactly how such a root already looks.
    t = await createTestApp({
      beforeSeed: async (root) => {
        await new ProjectConfigService(root).writeRaw(COMMON_SCOPE_ID, LEGACY_MODELS);
      },
    });
    new ProjectsRepo(t.deps.db).insert({
      projectId: COMMON_SCOPE_ID,
      ownerUserId: "admin",
      createdAt: new Date().toISOString(),
    });
    admin = apiClient(t.app, (await loginAdmin(t.app)).cookie);
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it("keeps that Project working for its owner and its members", async () => {
    const member = apiClient(t.app, (await provisionUser(t.app, "legacy_member")).cookie);
    const added = await admin.post(`/api/projects/${COMMON_SCOPE_ID}/members`, {
      userId: "legacy_member",
    });
    expect(added.status).toBe(201);
    // The collision must never take an existing Project away from the people using it.
    expect((await member.get(`/api/projects/${COMMON_SCOPE_ID}/models`)).status).toBe(200);
    expect((await member.get(`/api/projects/${COMMON_SCOPE_ID}/agents`)).status).toBe(200);
    expect(
      (
        (await (await member.get("/api/projects")).json()) as {
          projects: Array<{ projectId: string }>;
        }
      ).projects.map((p) => p.projectId),
    ).toContain(COMMON_SCOPE_ID);
  });

  it("lets a Session start inside it again", async () => {
    const created = await admin.post(`/api/projects/${COMMON_SCOPE_ID}/agents`, {
      agentId: "legacy_agent",
    });
    expect(created.status).toBe(201);
    // The reserved-id refusal must be off: this is an ordinary Project, and the session guard
    // would otherwise refuse the one thing its owner needs it for.
    const session = await admin.post(
      `/api/projects/${COMMON_SCOPE_ID}/agents/legacy_agent/sessions`,
      {},
    );
    expect(session.status).toBe(201);
  });

  it("reports the conflict on every common-scope-only surface", async () => {
    for (const res of [
      await admin.get("/api/common/plugins"),
      await admin.put("/api/common/plugins", { defaultPlugins: [] }),
      await admin.get("/api/common/agent-templates"),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "common_scope_conflict",
      );
    }
    // import-common too: without the guard it would copy that Project's own table into itself.
    await admin.post("/api/projects", { projectId: "unrelated_project" });
    const imported = await admin.post("/api/projects/unrelated_project/models/import-common", {});
    expect(imported.status).toBe(409);
  });

  it("does not seed new Projects from that Project's table", async () => {
    const created = (await (
      await admin.post("/api/projects", { projectId: "unseeded_project" })
    ).json()) as ProjectCreateResponse;
    const body = (await (
      await admin.get(`/api/projects/${created.project.projectId}/models`)
    ).json()) as ModelsResponse;
    // The built-in presets, not the other Project's credentials: the preset catalog carries no
    // key at all, so the legacy project's credential is the honest marker for "did it leak".
    expect(body.models.length).toBeGreaterThan(0);
    expect(
      await fs.readFile(path.join(t.root, "unseeded_project", ".project_config.toml"), "utf8"),
    ).not.toContain("sk-legacy");
  });

  it("still renames and deletes that Project like any other, and the scope comes back afterwards", async () => {
    // Renaming a Project only relabels it (the id is immutable by design), so it must work here
    // too: the fallback exists so the collision costs that Project's users nothing.
    const renamed = await admin.patch(`/api/projects/${COMMON_SCOPE_ID}`, { name: "Old project" });
    expect(renamed.status).toBe(200);
    expect((await admin.get("/api/common/plugins")).status).toBe(409);

    // Deleting it is the supported way out: it is that Project's own data, and its removal leaves
    // the reserved id free again — the scope is available immediately, without a restart.
    expect((await admin.delete(`/api/projects/${COMMON_SCOPE_ID}`)).status).toBe(204);
    expect((await admin.get("/api/common/plugins")).status).toBe(200);
    expect((await admin.get("/api/common/agent-templates")).status).toBe(200);
  });

  it("turns the scope back on once the Project is re-keyed by hand", async () => {
    // The other way out, and the one the conflict message points at for a Project whose data has
    // to be kept: changing the row's id (with the directory) is a data-root operation, since no
    // surface exposes an id change. The predicate is evaluated per call, so no restart is needed.
    t.deps.db
      .prepare("UPDATE projects SET project_id = ? WHERE project_id = ?")
      .run("renamed_project", COMMON_SCOPE_ID);
    const res = await admin.get("/api/common/plugins");
    expect(res.status).toBe(200);
    expect((await admin.get(`/api/projects/${COMMON_SCOPE_ID}/models`)).status).toBe(200);
  });
});
