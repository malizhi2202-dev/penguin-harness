/**
 * Access to a Project's single timer file, `<projectDir>/timers.toml`.
 *
 * Deliberately not an mtime-gated cache like the Agent schedule directory: that cache exists
 * because a tick had to walk one directory per Agent and parse one file per task, while this
 * is one small file per Project. Stat-ing and caching it would be more code than reading it.
 *
 * Reads are fault-tolerant (an unusable file is reported to the caller and skipped); writes
 * only go through the API route, and are full-file replacements expressing user intent — the
 * system never rewrites existing content.
 */
import fs from "node:fs/promises";
import { atomicWriteFile, projectTimersFile } from "@prismshadow/penguin-core";
import { parseProjectTimersFile, type ProjectTimersParseResult } from "./project-timer-file.js";

export interface ProjectTimersFile {
  raw: string;
  parsed: ProjectTimersParseResult;
}

/** Reads and parses the Project's timer file; null when the Project declares none. */
export async function readProjectTimers(
  root: string,
  projectId: string,
): Promise<ProjectTimersFile | null> {
  try {
    const raw = await fs.readFile(projectTimersFile(root, projectId), "utf8");
    return { raw, parsed: parseProjectTimersFile(raw) };
  } catch {
    return null;
  }
}

/** Replaces the Project's timer file (the route validates before calling). */
export async function writeProjectTimers(
  root: string,
  projectId: string,
  raw: string,
): Promise<void> {
  await atomicWriteFile(projectTimersFile(root, projectId), raw, { followSymlinks: true });
}
