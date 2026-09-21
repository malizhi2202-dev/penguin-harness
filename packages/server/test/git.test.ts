/**
 * Integration tests for the Git page's server surface (`/api/projects/:projectId/git/…`).
 *
 * The fixtures are real repositories in a temp directory, not mocks: the whole point of this
 * module is what git actually prints, so a fake would pin the parser against itself. What is
 * covered here is the contract the page depends on — discovery dedupes Workspaces that sit in
 * one repository and skips the ones that are not repositories at all; the log is newest-first and
 * pages; status separates staged from unstaged from untracked; a diff is produced for each of
 * those three, and for a commit; staging, committing and switching branches change what the next
 * read reports.
 *
 * The other half is the refusal side, which is why every value reaching git is validated: an
 * outsider sees 404 rather than 403, a relative or missing directory is a 400/404 rather than a
 * command run somewhere unexpected, a pathspec that leaves the repository is refused, an unknown
 * branch is refused, and a revision that looks like an option (`--output=…`) never reaches a
 * command line — it is resolved to a SHA first, and the file it names is never written.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitCommitDetail,
  GitDiffResponse,
  GitLogResponse,
  GitOpResponse,
  GitRepoDetail,
  GitRepoListResponse,
  ProjectCreateResponse,
  SessionCreateResponse,
} from "../src/api/types.js";
import { apiClient, createTestApp, provisionUser } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const exec = promisify(execFile);

/** Runs git in a fixture repository. Identity is set per repository so the host's config cannot leak in. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout;
}

describe("git api", () => {
  let t: TestApp;
  let owner: ReturnType<typeof apiClient>;
  let outsider: ReturnType<typeof apiClient>;
  let projectId: string;
  let scratch: string;
  /** A repository with two commits, a staged file, an unstaged edit, an untracked file and a second branch. */
  let repo: string;
  /** A directory inside `repo` — the second Workspace of the same repository. */
  let nested: string;
  /** A directory that is not inside any repository. */
  let plain: string;
  /** The repository's initial branch name (git's default, which depends on its version). */
  let trunk: string;

  const url = (suffix: string) => `/api/projects/${projectId}/git${suffix}`;

  /** A Session's Workspace is what makes a directory a discovery candidate. */
  const sessionIn = async (dir: string) => {
    const res = await owner.post(`/api/projects/${projectId}/agents/default_agent/sessions`, {
      workspace: dir,
    });
    // The body, not just the status: a failed fixture has to say why it failed.
    if (res.status !== 201)
      throw new Error(`session create failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SessionCreateResponse;
  };

  beforeEach(async () => {
    t = await createTestApp();
    const a = await provisionUser(t.app, "owner_g");
    const b = await provisionUser(t.app, "outsider_g");
    owner = apiClient(t.app, a.cookie);
    outsider = apiClient(t.app, b.cookie);
    const created = (await (
      await owner.post("/api/projects", { projectId: "owner_g-git", name: "Git project" })
    ).json()) as ProjectCreateResponse;
    projectId = created.project.projectId;
    // Creating a Session resolves a Model, so the Project needs one before the fixtures below can
    // hand it a Workspace.
    await owner.put(`/api/projects/${projectId}/models`, {
      defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      models: [{ provider: "anthropic", modelId: "claude-sonnet-4-6" }],
    });

    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "penguin-git-test-"));
    repo = path.join(scratch, "repo");
    nested = path.join(repo, "nested");
    plain = path.join(scratch, "plain");
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(plain, { recursive: true });

    await git(repo, "init");
    await git(repo, "config", "user.name", "Fixture");
    await git(repo, "config", "user.email", "fixture@example.com");
    await fs.writeFile(path.join(repo, "a.txt"), "one\n");
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-m", "first commit");
    trunk = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    await fs.writeFile(path.join(repo, "b.txt"), "two\n");
    await git(repo, "add", "b.txt");
    await git(repo, "commit", "-m", "second commit");
    await git(repo, "checkout", "-b", "topic");
    await git(repo, "checkout", trunk);

    // One of each status: staged addition, unstaged edit, untracked file.
    await fs.writeFile(path.join(repo, "staged.txt"), "staged\n");
    await git(repo, "add", "staged.txt");
    await fs.writeFile(path.join(repo, "a.txt"), "one\nedited\n");
    await fs.writeFile(path.join(repo, "untracked.txt"), "untracked\n");
  });

  afterEach(async () => {
    await t.cleanup();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("discovers one row per repository, however many Workspaces sit in it", async () => {
    await sessionIn(repo);
    await sessionIn(nested);
    await sessionIn(plain);

    const res = await owner.get(url("/repos"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as GitRepoListResponse;
    expect(body.repos).toHaveLength(1);
    const [row] = body.repos;
    expect(row?.root).toBe(await fs.realpath(repo));
    expect(row?.name).toBe("repo");
    expect(row?.branch).toBe(trunk);
    expect(row?.head?.subject).toBe("second commit");
    expect(row?.dirty).toBe(true);
    expect(row?.empty).toBe(false);
  });

  it("takes an extra candidate from the query, and skips one that is not a repository", async () => {
    const res = await owner.get(`${url("/repos")}?extra=${encodeURIComponent(plain)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as GitRepoListResponse).repos).toEqual([]);

    const withRepo = await owner.get(`${url("/repos")}?extra=${encodeURIComponent(repo)}`);
    expect(((await withRepo.json()) as GitRepoListResponse).repos).toHaveLength(1);
  });

  it("reports the repository: branch, status counts, branches and remotes", async () => {
    await sessionIn(repo);
    const res = await owner.get(`${url("/repo")}?path=${encodeURIComponent(repo)}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as GitRepoDetail;
    expect(detail.branch).toBe(trunk);
    expect(detail.detached).toBe(false);
    expect(detail.upstream).toBeNull();
    expect(detail.ahead).toBe(0);
    expect(detail.behind).toBe(0);
    expect(detail.remotes).toEqual([]);
    expect(detail.status.counts).toEqual({
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
    });
    expect(detail.status.files.map((f) => f.path).sort()).toEqual([
      "a.txt",
      "staged.txt",
      "untracked.txt",
    ]);
    expect(detail.branches.map((b) => b.name).sort()).toEqual(["topic", trunk].sort());
    expect(detail.branches.find((b) => b.current)?.name).toBe(trunk);
  });

  it("pages the log newest-first and refuses a revision that does not resolve", async () => {
    await sessionIn(repo);
    const first = await owner.get(`${url("/log")}?path=${encodeURIComponent(repo)}&limit=1`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as GitLogResponse;
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]?.subject).toBe("second commit");
    expect(page.hasMore).toBe(true);

    const rest = await owner.get(
      `${url("/log")}?path=${encodeURIComponent(repo)}&limit=1&offset=1`,
    );
    expect(((await rest.json()) as GitLogResponse).commits[0]?.subject).toBe("first commit");

    const bad = await owner.get(`${url("/log")}?path=${encodeURIComponent(repo)}&ref=nope`);
    expect(bad.status).toBe(404);
  });

  it("never lets a revision that looks like an option reach a command line", async () => {
    await sessionIn(repo);
    const target = path.join(scratch, "injected.txt");
    const res = await owner.get(
      `${url("/log")}?path=${encodeURIComponent(repo)}&ref=${encodeURIComponent(`--output=${target}`)}`,
    );
    // Refused before git is asked: a revision is resolved to a SHA first, and an argument that
    // reads as an option is not a revision.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_revision");
    // The proof is on disk: git would have written the file had the argument been passed through.
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("reads a diff for an unstaged edit, a staged addition, an untracked file and a commit", async () => {
    await sessionIn(repo);
    const base = `${url("/diff")}?path=${encodeURIComponent(repo)}`;

    const unstaged = (await (await owner.get(`${base}&file=a.txt`)).json()) as GitDiffResponse;
    expect(unstaged.kind).toBe("unstaged");
    expect(unstaged.patch).toContain("+edited");

    const staged = (await (
      await owner.get(`${base}&file=staged.txt&staged=1`)
    ).json()) as GitDiffResponse;
    expect(staged.kind).toBe("staged");
    expect(staged.patch).toContain("+staged");

    const untracked = (await (
      await owner.get(`${base}&file=untracked.txt`)
    ).json()) as GitDiffResponse;
    expect(untracked.kind).toBe("untracked");
    expect(untracked.patch).toContain("+untracked");

    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    const commit = (await (await owner.get(`${base}&ref=${head}`)).json()) as GitDiffResponse;
    expect(commit.kind).toBe("commit");
    expect(commit.patch).toContain("b.txt");
  });

  it("reads one commit with its message body and per-file line counts", async () => {
    await sessionIn(repo);
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    const res = await owner.get(
      `${url("/commit")}?path=${encodeURIComponent(repo)}&ref=${head.slice(0, 8)}`,
    );
    expect(res.status).toBe(200);
    const detail = (await res.json()) as GitCommitDetail;
    expect(detail.sha).toBe(head);
    expect(detail.subject).toBe("second commit");
    expect(detail.author.name).toBe("Fixture");
    expect(detail.files).toEqual([
      { path: "b.txt", origPath: null, additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("names both sides of a rename, and only the surviving path of a deletion", async () => {
    await sessionIn(repo);
    await git(repo, "commit", "-m", "add staged");
    await git(repo, "mv", "b.txt", "renamed.txt");
    await git(repo, "commit", "-m", "rename b");
    await git(repo, "rm", "--quiet", "renamed.txt");
    await git(repo, "commit", "-m", "delete it");

    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    const deleted = (await (
      await owner.get(`${url("/commit")}?path=${encodeURIComponent(repo)}&ref=${head}`)
    ).json()) as GitCommitDetail;
    // A deletion has no post-image path, and it is not a rename: the row names the file it had.
    expect(deleted.files).toEqual([
      { path: "renamed.txt", origPath: null, additions: 0, deletions: 1, binary: false },
    ]);

    const renameSha = (await git(repo, "rev-parse", "HEAD~1")).trim();
    const renamed = (await (
      await owner.get(`${url("/commit")}?path=${encodeURIComponent(repo)}&ref=${renameSha}`)
    ).json()) as GitCommitDetail;
    expect(renamed.files).toEqual([
      { path: "renamed.txt", origPath: "b.txt", additions: 0, deletions: 0, binary: false },
    ]);
  });

  it("stages, unstages and commits through the page's buttons", async () => {
    await sessionIn(repo);
    const repoQuery = `?path=${encodeURIComponent(repo)}`;

    const staged = await owner.post(url("/stage"), { path: repo, files: ["untracked.txt"] });
    expect(staged.status).toBe(200);
    const afterStage = (await (
      await owner.get(`${url("/repo")}${repoQuery}`)
    ).json()) as GitRepoDetail;
    expect(afterStage.status.counts.staged).toBe(2);
    expect(afterStage.status.counts.untracked).toBe(0);

    const unstaged = await owner.post(url("/unstage"), { path: repo, files: ["untracked.txt"] });
    expect(unstaged.status).toBe(200);
    const afterUnstage = (await (
      await owner.get(`${url("/repo")}${repoQuery}`)
    ).json()) as GitRepoDetail;
    expect(afterUnstage.status.counts.untracked).toBe(1);

    const empty = await owner.post(url("/commit"), { path: repo, message: "   " });
    expect(empty.status).toBe(400);

    const commit = await owner.post(url("/commit"), { path: repo, message: "stage the fixture" });
    expect(commit.status).toBe(200);
    const { sha } = (await commit.json()) as GitOpResponse;
    expect(sha).toBe((await git(repo, "rev-parse", "HEAD")).trim());

    const log = (await (
      await owner.get(`${url("/log")}${repoQuery}&limit=1`)
    ).json()) as GitLogResponse;
    expect(log.commits[0]?.subject).toBe("stage the fixture");
    expect(log.commits[0]?.sha).toBe(sha);
  });

  it("switches to a branch that exists and refuses one that does not", async () => {
    await sessionIn(repo);
    const res = await owner.post(url("/checkout"), { path: repo, branch: "topic" });
    expect(res.status).toBe(200);
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("topic");

    const missing = await owner.post(url("/checkout"), { path: repo, branch: "nope" });
    expect(missing.status).toBe(404);
    const option = await owner.post(url("/checkout"), { path: repo, branch: "--force" });
    expect(option.status).toBe(400);
  });

  it("refuses a pathspec that leaves the repository, and a file path that is an option", async () => {
    await sessionIn(repo);
    const escape = await owner.post(url("/stage"), { path: repo, files: ["../../etc/passwd"] });
    expect(escape.status).toBe(400);
    const absolute = await owner.post(url("/stage"), { path: repo, files: ["/etc/passwd"] });
    expect(absolute.status).toBe(400);
    const option = await owner.post(url("/stage"), { path: repo, files: ["--force"] });
    expect(option.status).toBe(400);

    const diffEscape = await owner.get(
      `${url("/diff")}?path=${encodeURIComponent(repo)}&file=${encodeURIComponent("../a.txt")}`,
    );
    expect(diffEscape.status).toBe(400);
  });

  it("refuses a directory that is not a repository, a relative path and a missing one", async () => {
    await sessionIn(repo);
    const notRepo = await owner.get(`${url("/repo")}?path=${encodeURIComponent(plain)}`);
    expect(notRepo.status).toBe(404);
    const relative = await owner.get(`${url("/repo")}?path=nested`);
    expect(relative.status).toBe(400);
    const missing = await owner.get(
      `${url("/repo")}?path=${encodeURIComponent(path.join(scratch, "gone"))}`,
    );
    expect(missing.status).toBe(404);
  });

  it("answers git's own failure when a push has nowhere to go", async () => {
    await sessionIn(repo);
    const res = await owner.post(url("/push"), { path: repo });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("git_failed");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("hides every route from a caller without access to the Project", async () => {
    await sessionIn(repo);
    const repoQuery = `?path=${encodeURIComponent(repo)}`;
    expect((await outsider.get(url("/repos"))).status).toBe(404);
    expect((await outsider.get(`${url("/repo")}${repoQuery}`)).status).toBe(404);
    expect((await outsider.get(`${url("/log")}${repoQuery}`)).status).toBe(404);
    expect((await outsider.get(`${url("/diff")}${repoQuery}`)).status).toBe(404);
    expect((await outsider.post(url("/stage"), { path: repo, files: ["a.txt"] })).status).toBe(404);
    expect((await outsider.post(url("/commit"), { path: repo, message: "x" })).status).toBe(404);
    expect((await outsider.post(url("/checkout"), { path: repo, branch: trunk })).status).toBe(404);
    expect((await outsider.post(url("/fetch"), { path: repo })).status).toBe(404);
    expect((await outsider.post(url("/pull"), { path: repo })).status).toBe(404);
    expect((await outsider.post(url("/push"), { path: repo })).status).toBe(404);
  });
});
