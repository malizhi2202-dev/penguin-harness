/**
 * Integration tests for the Project alignment pass (`services/project-alignment.ts`).
 *
 * The fixtures are real repositories in a temp directory with a real bare origin, not mocks:
 * the whole subject of this module is what git actually does to a branch, so a fake would pin
 * the parser against itself. What is covered is the contract the timer depends on — the pass
 * commits what the work tree holds and says what it committed; a clean branch is fast-forwarded
 * and a diverged one is reported instead of merged; a conflicting merge is ABORTED and the work
 * tree is left exactly as it was; an unfinished operation is left alone; a dry run writes
 * nothing; and the drift checks find a document's dangling reference with its line.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runAlignment,
  statusOf,
  summarizeCommit,
  type AlignmentOptions,
} from "../src/services/project-alignment.js";

const exec = promisify(execFile);

/** Runs git in a fixture repository. Identity is set per repository so the host's config cannot leak in. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

/** git's exit code for a command expected to fail (a conflicting merge, a refused fast-forward). */
async function gitFails(cwd: string, ...args: string[]): Promise<number> {
  try {
    await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return 0;
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    return typeof code === "number" ? code : 1;
  }
}

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

interface Fixture {
  scratch: string;
  origin: string;
  /** The repository's initial branch name (git's default, which depends on its version). */
  branch: string;
  /** The repository under alignment, with `origin/main` as its upstream. */
  work: string;
  /** A second clone used to move the remote forward. */
  peer: string;
}

async function makeFixture(): Promise<Fixture> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-align-"));
  const origin = path.join(scratch, "origin.git");
  await git(scratch, "init", "--bare", origin);
  const work = path.join(scratch, "work");
  await fs.mkdir(work);
  await git(work, "init");
  // Read the branch git actually created rather than naming one: `init -b` needs git 2.28.
  const branch = (await git(work, "symbolic-ref", "--short", "HEAD")).trim();
  await git(work, "config", "user.email", "timer@example.com");
  await git(work, "config", "user.name", "Timer Test");
  await write(path.join(work, "src/app.ts"), "export const value = 1;\n");
  await write(path.join(work, "README.md"), "# Fixture\n");
  await commitAll(work, "init");
  await git(work, "remote", "add", "origin", origin);
  await git(work, "push", "-u", "origin", branch);
  const peer = path.join(scratch, "peer");
  await git(scratch, "clone", origin, peer);
  await git(peer, "config", "user.email", "peer@example.com");
  await git(peer, "config", "user.name", "Peer");
  return { scratch, origin, branch, work, peer };
}

/** Move `origin/main` forward from the peer clone. */
async function advanceRemote(fx: Fixture, mutate: (peer: string) => Promise<void>): Promise<void> {
  await git(fx.peer, "pull", "--ff-only");
  await mutate(fx.peer);
  await commitAll(fx.peer, "remote change");
  await git(fx.peer, "push");
}

const AT = "2026-09-22T01:00:00.000Z";

function options(work: string, overrides: Partial<AlignmentOptions> = {}): AlignmentOptions {
  return {
    workspaces: [work],
    sync: "none",
    commit: "off",
    docs: true,
    dryRun: false,
    timerName: "git-align",
    now: () => Date.parse(AT),
    ...overrides,
  };
}

describe("project alignment pass", () => {
  let fx: Fixture;
  let scratch: string;

  beforeEach(async () => {
    fx = await makeFixture();
    scratch = fx.scratch;
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("commits the work tree, reports what it committed, and flags code without docs", async () => {
    await write(path.join(fx.work, "src/app.ts"), "export const value = 2;\n");

    const summary = await runAlignment(options(fx.work, { commit: "auto" }));

    expect(summary.counts.repos).toBe(1);
    expect(summary.counts.committed).toBe(1);
    const repo = summary.repos[0]!;
    expect(repo.actions.some((a) => a.startsWith("committed 1 file(s) as "))).toBe(true);
    // The message is generated from the diff itself, so it names the file count and the origin.
    const subject = (await git(fx.work, "log", "-1", "--pretty=%s")).trim();
    expect(subject).toBe("chore(timer): checkpoint 1 file(s) (+1 −1)");
    const body = await git(fx.work, "log", "-1", "--pretty=%b");
    expect(body).toContain(
      'Auto-committed by the "git-align" Project timer at 2026-09-22T01:00:00.000Z.',
    );
    // The change set is now the local commit ahead of upstream: code moved, no document did.
    const finding = repo.findings.find((f) => f.kind === "code_without_docs");
    expect(finding?.severity).toBe("attention");
    expect(finding?.files).toEqual(["src/app.ts"]);
    expect(statusOf(summary)).toBe("drift");
  });

  it("leaves the tree alone in a dry run, and says what a real run would have committed", async () => {
    await write(path.join(fx.work, "src/app.ts"), "export const value = 3;\n");
    const before = (await git(fx.work, "rev-parse", "HEAD")).trim();

    const summary = await runAlignment(options(fx.work, { commit: "auto", dryRun: true }));

    expect((await git(fx.work, "rev-parse", "HEAD")).trim()).toBe(before);
    expect(summary.counts.committed).toBe(0);
    const dirty = summary.repos[0]!.findings.find((f) => f.kind === "dirty_worktree");
    expect(dirty?.detail).toContain("a real run would commit them");
    expect(dirty?.files).toContain("src/app.ts");
  });

  it("fast-forwards a clean branch that is behind its upstream", async () => {
    await advanceRemote(fx, async (peer) => {
      await write(path.join(peer, "src/app.ts"), "export const value = 9;\n");
    });

    const summary = await runAlignment(options(fx.work, { sync: "fast-forward" }));

    const repo = summary.repos[0]!;
    expect(repo.actions).toContain("fetched");
    expect(repo.actions.some((a) => a.startsWith(`fast-forwarded to origin/${fx.branch}`))).toBe(
      true,
    );
    expect(summary.counts.merged).toBe(1);
    expect(repo.findings).toEqual([]);
    expect(statusOf(summary)).toBe("merged");
    // The branch really moved: the peer's content is what HEAD now holds.
    expect(await fs.readFile(path.join(fx.work, "src/app.ts"), "utf8")).toBe(
      "export const value = 9;\n",
    );
  });

  it("refuses to fast-forward a diverged branch, and reports why instead of merging", async () => {
    await write(path.join(fx.work, "src/local.ts"), "export const local = true;\n");
    await commitAll(fx.work, "local work");
    await advanceRemote(fx, async (peer) => {
      await write(path.join(peer, "src/remote.ts"), "export const remote = true;\n");
    });
    const head = (await git(fx.work, "rev-parse", "HEAD")).trim();

    const summary = await runAlignment(options(fx.work, { sync: "fast-forward" }));

    const repo = summary.repos[0]!;
    expect(repo.ahead).toBe(1);
    expect(repo.behind).toBe(1);
    expect(repo.findings.map((f) => f.kind)).toContain("diverged");
    expect(summary.counts.merged).toBe(0);
    // Nothing was merged and nothing was rewritten.
    expect((await git(fx.work, "rev-parse", "HEAD")).trim()).toBe(head);
    expect((await git(fx.work, "log", "--merges", "--oneline")).trim()).toBe("");
  });

  it("aborts a conflicting merge and leaves the work tree exactly as it was", async () => {
    await write(path.join(fx.work, "src/app.ts"), "export const value = 2;\n");
    await commitAll(fx.work, "local change");
    await advanceRemote(fx, async (peer) => {
      await write(path.join(peer, "src/app.ts"), "export const value = 100;\n");
    });
    const head = (await git(fx.work, "rev-parse", "HEAD")).trim();

    const summary = await runAlignment(options(fx.work, { sync: "merge" }));

    const conflict = summary.repos[0]!.findings.find((f) => f.kind === "merge_conflict");
    expect(conflict?.severity).toBe("attention");
    expect(conflict?.detail).toContain("aborted and the work tree restored");
    // The repository is not left mid-merge: no MERGE_HEAD, no conflict markers, same HEAD.
    await expect(
      git(fx.work, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"),
    ).rejects.toBeTruthy();
    expect((await git(fx.work, "status", "--porcelain")).trim()).toBe("");
    expect(await fs.readFile(path.join(fx.work, "src/app.ts"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    expect((await git(fx.work, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("leaves a repository alone while an operation is in progress", async () => {
    await write(path.join(fx.work, "src/app.ts"), "export const value = 2;\n");
    await commitAll(fx.work, "local change");
    await advanceRemote(fx, async (peer) => {
      await write(path.join(peer, "src/app.ts"), "export const value = 100;\n");
    });
    await git(fx.work, "fetch");
    // Start the conflicting merge by hand and leave it unresolved, as an Agent's turn would.
    expect(await gitFails(fx.work, "merge", `origin/${fx.branch}`)).not.toBe(0);
    const head = (await git(fx.work, "rev-parse", "HEAD")).trim();
    await write(path.join(fx.work, "src/app.ts"), "export const value = 3;\n");

    const summary = await runAlignment(options(fx.work, { commit: "auto", sync: "fast-forward" }));

    const repo = summary.repos[0]!;
    expect(repo.findings.map((f) => f.kind)).toEqual(["operation_in_progress"]);
    expect(repo.actions).toEqual([]);
    expect(summary.counts.committed).toBe(0);
    expect((await git(fx.work, "rev-parse", "HEAD")).trim()).toBe(head);
  });

  it("finds a changed document's dangling reference, with the line it sits on", async () => {
    await write(
      path.join(fx.work, "docs/note.md"),
      ["# Note", "", "See [the service](./gone.md) for details.", ""].join("\n"),
    );
    await commitAll(fx.work, "add a note with a dangling link");

    const summary = await runAlignment(options(fx.work));

    const broken = summary.repos[0]!.findings.find((f) => f.kind === "broken_doc_refs");
    expect(broken?.severity).toBe("attention");
    expect(broken?.files).toEqual(["docs/note.md:3 → ./gone.md"]);
    // A document that exists is not reported, and neither is prose that only looks like a path.
    await write(path.join(fx.work, "docs/real.md"), "# Real\n");
    await write(
      path.join(fx.work, "docs/ok.md"),
      ["# Ok", "", "See [the service](./real.md) and the `value` field.", ""].join("\n"),
    );
    await commitAll(fx.work, "add a valid note");
    const second = await runAlignment(options(fx.work));
    expect(second.repos[0]!.findings.find((f) => f.kind === "broken_doc_refs")?.files).toEqual([
      "docs/note.md:3 → ./gone.md",
    ]);
  });

  it("reports the commits that have not landed, and says a branch with no upstream has no change set", async () => {
    await write(path.join(fx.work, "src/app.ts"), "export const value = 4;\n");
    await commitAll(fx.work, "a change waiting to land");

    const summary = await runAlignment(options(fx.work));
    const landed = summary.repos[0]!.findings.find((f) => f.kind === "commits_not_landed");
    expect(landed?.detail).toContain("a change waiting to land");
    expect(landed?.severity).toBe("info");

    // A branch with no upstream cannot have a not-yet-landed change set, and says so.
    await git(fx.work, "branch", "--unset-upstream");
    const orphan = await runAlignment(options(fx.work));
    expect(orphan.repos[0]!.findings.map((f) => f.kind)).toContain("no_upstream");
  });
});

describe("summarizeCommit", () => {
  it("groups files by their first directory and counts the lines", () => {
    const message = summarizeCommit(
      [
        { path: "packages/server/src/a.ts", additions: 10, deletions: 2, binary: false },
        { path: "packages/server/src/b.ts", additions: 5, deletions: 1, binary: false },
        { path: "packages/web/src/c.tsx", additions: 3, deletions: 0, binary: false },
        { path: "icon.png", additions: 0, deletions: 0, binary: true },
      ],
      "git-align",
      AT,
    );
    expect(message.split("\n")[0]).toBe("chore(timer): checkpoint 4 file(s) (+18 −3)");
    // Column padding is cosmetic; the grouping and the counts are the contract.
    const lines = message.split("\n").map((line) => line.replace(/ +/g, " "));
    expect(lines).toContain("packages/server 2 file(s) +15 −3");
    expect(lines).toContain("packages/web 1 file(s) +3 −0");
    expect(message).toContain("1 binary file(s) not counted in the line totals.");
  });
});
