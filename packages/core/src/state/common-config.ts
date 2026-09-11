/**
 * The data root's common configuration scope (`<root>/common/`, see paths.ts COMMON_SCOPE_ID):
 * the place a user configures something **once** for every Project on this data root.
 *
 * Three things live there, and each inherits into a Project by its own rule — the difference is
 * the whole point, so it is stated once here:
 *
 * - **Models** — `<root>/common/.project_config.toml`, the same file shape a Project carries and
 *   read by the ordinary Project config loader. A new Project is seeded with a **copy** of that
 *   table (credentials included, so it is usable the moment it appears), and an existing Project
 *   copies it on demand through the import action. Copied means copied: later edits on either
 *   side never travel to the other (see project-config.ts `mergeCommonModels`).
 * - **Agent templates** — `<root>/common/agents/<agentId>/agent_state/…`, an ordinary Agent
 *   State directory. Creating an Agent from a template **copies that Agent's behavior** into the
 *   new one (see agent-state.ts `copyAgentStateFrom`); `.vault.toml`, `memory/` and `schedule/`
 *   stay behind, because secrets, that Agent's personal memory and its timed work are not
 *   behavior.
 * - **Default plugin set** — `<root>/common/plugins.toml` (this module): the library plugins a
 *   newly created Agent gets when whoever creates it picks none. An absent file means "no
 *   defaults", which is exactly the pre-existing behavior of a plain new Agent — so a data root
 *   that never configures this behaves as it always did.
 *
 * Nothing here is mandatory: with no `common/` directory at all, every surface keeps its old
 * behavior.
 *
 * Docs: /docs/configuration § "Common config".
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteFile } from "../internal/atomic-write.js";
import { commonDir } from "./paths.js";

/** `<root>/common/plugins.toml`: the common default plugin set's file shape. */
export interface CommonPluginsConfig {
  /**
   * Library plugin names (one per plugin, each pulling in its skills and hook package) that a
   * newly created Agent is seeded with when the creator selects nothing. Order is preserved —
   * it is the order the installs run in, and the picker shows it back to the user.
   */
  default_plugins: string[];
}

/** `<root>/common/plugins.toml`. */
export function commonPluginsPath(root: string): string {
  return path.join(commonDir(root), "plugins.toml");
}

/**
 * Reads the common default plugin set. A missing file (or one without a usable
 * `default_plugins` list) reads as an empty set rather than an error: the common scope is
 * optional by design, and "unconfigured" and "explicitly empty" lead to the same install.
 *
 * Names are returned as stored — validating them against the library is the caller's job,
 * because only the interface layer can turn an unknown name into a 400 the user can act on.
 */
export async function loadCommonDefaultPlugins(root: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(commonPluginsPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const parsed = (parseToml(raw) ?? {}) as Record<string, unknown>;
  const list = parsed.default_plugins;
  if (!Array.isArray(list)) return [];
  return list.filter((name): name is string => typeof name === "string" && name !== "");
}

/**
 * Writes the common default plugin set. Callers are expected to have resolved the names
 * against the library first, so an unknown name never reaches the file (a default set that
 * fails to install on every new Agent would be a trap to debug later).
 */
export async function saveCommonDefaultPlugins(
  root: string,
  names: readonly string[],
): Promise<void> {
  const file = commonPluginsPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const config: CommonPluginsConfig = { default_plugins: [...names] };
  await atomicWriteFile(file, stringifyToml(config), { mode: 0o600, followSymlinks: true });
}
