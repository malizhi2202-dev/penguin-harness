/**
 * Local git repositories, for the Web App's Git page.
 *
 * The page's scope is a Project's Workspaces (the directories its Sessions ran in) plus any
 * directory the page adds by hand. Only the ones that sit inside a work tree are interesting,
 * so discovery resolves every candidate to its repository top level and dedupes by that root:
 * two Workspaces inside one repository are one row.
 *
 * Every command runs through `execFile` with an argv array (`git -c … -C <dir> …`), never a
 * shell, and every user-supplied value is checked *before* it reaches git: a pathspec must
 * resolve inside the repository root, a branch must already exist in the repository (or pass
 * `check-ref-format` when creating one), a remote must be one `git remote` lists, and a
 * revision is substituted by the SHA that `rev-parse --verify` resolved it to — so no request
 * can smuggle an option or an arbitrary revision expression into a command line.
 *
 * The reads (discovery, log, status, diff, branches) never write. The mutating calls — stage,
 * unstage, commit, checkout, fetch, pull, push — exist only for the page's buttons.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitDiffResponse,
  GitLogResponse,
  GitRepoDetail,
  GitRepoListResponse,
  GitRepoSummary,
  GitStatusFile,
  GitStatusSummary,
} from "../api/types.js";
import { HttpError } from "../http/errors.js";

/** Reads are cheap; a git that never returns is not. */
const READ_TIMEOUT_MS = 20_000;
/** A commit runs the repository's own hooks; a slow pre-commit is the user's choice, not a hang. */
const COMMIT_TIMEOUT_MS = 120_000;
/** A checkout writes the work tree. */
const CHECKOUT_TIMEOUT_MS = 60_000;
/** fetch / pull / push talk to a remote over ssh or https while the user waits on the button. */
const NETWORK_TIMEOUT_MS = 180_000;
/** One command's output cap (a log or a patch of a large repository has no natural bound). */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** What a single patch may hand to the page; the rest comes back as `truncated`. */
const MAX_PATCH_CHARS = 400_000;
/** What a single commit body may hand to the page. */
const MAX_BODY_CHARS = 8_000;
/** Repositories one scan resolves; the overflow is reported rather than silently dropped. */
const MAX_SCAN = 40;
const SCAN_CONCURRENCY = 4;

/** Field (0x1f) and record (0x1e) separators: neither can appear in a commit subject or a ref. */
const FS = "\x1f";
const RS = "\x1e";

const LOG_FIELDS = ["%H", "%h", "%an", "%ae", "%aI", "%cI", "%s", "%D", "%P"].join(FS);
/** `%(refname)` first: the full ref is what tells a local branch from a remote-tracking one. */
const BRANCH_FIELDS = [
  "%(refname)",
  "%(refname:short)",
  "%(objectname:short)",
  "%(upstream:short)",
  "%(committerdate:iso-strict)",
  "%(contents:subject)",
].join(FS);

/** Characters git refuses in a ref name, plus the whitespace and controls a shell would not need anyway. */
const FORBIDDEN_REF_CHARS = [" ", "\t", "\n", "~", "^", ":", "?", "*", "[", "\\"];

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface GitRunOptions {
  timeoutMs?: number;
}

function gitUnavailable(): HttpError {
  return new HttpError(503, "git_unavailable", "git is not available on the server.");
}

/**
 * The environment every command runs in: no credential prompt can block a request (the page
 * shows the failure instead), no pager can wait on a terminal, and no editor can open — a merge
 * or a rebase that needs one fails with git's own message rather than hanging until the timeout.
 * `GIT_OPTIONAL_LOCKS=0` keeps a read from taking the index lock: the Agent runs git in the same
 * Workspace, and a lock collision would look like a broken page.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    LC_ALL: "C",
    LANG: "C",
  };
}

/** Runs one git command; a non-zero exit is a result, not a throw (callers decide what it means). */
async function runGit(dir: string, args: string[], options: GitRunOptions = {}): Promise<GitRun> {
  return await new Promise<GitRun>((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", "-C", dir, ...args],
      {
        timeout: options.timeoutMs ?? READ_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "utf8",
        env: gitEnvironment(),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err && err.code === "ENOENT") {
          reject(gitUnavailable());
          return;
        }
        // A timeout arrives as a killed child with no exit code; git's own failures carry one.
        const timedOut = Boolean(err && (err.killed === true || err.signal));
        const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", timedOut });
      },
    );
  });
}

/** git's own words, first three lines, for a page-level error message. */
function gitFailure(what: string, run: GitRun): HttpError {
  if (run.timedOut) return new HttpError(504, "git_timeout", `${what} timed out.`);
  const detail = (run.stderr.trim() || run.stdout.trim()).split("\n").slice(0, 3).join(" ");
  return new HttpError(400, "git_failed", detail ? `${what} failed: ${detail}` : `${what} failed.`);
}

/** Runs one git command and returns its stdout, or throws the page-level error for it. */
async function mustGit(
  dir: string,
  args: string[],
  what: string,
  options: GitRunOptions = {},
): Promise<string> {
  const run = await runGit(dir, args, options);
  if (run.code !== 0) throw gitFailure(what, run);
  return run.stdout;
}

/**
 * A user-supplied pathspec, made safe by construction: relative to the repository root and
 * resolving inside it. An absolute path, a `..` escape and a leading `-` (which a dropped `--`
 * would turn into an option) are all refused; the root itself is refused too, since every
 * caller means one file or one directory below it.
 */
export function safePathspec(root: string, raw: string): string {
  const value = raw.trim();
  if (!value) throw new HttpError(400, "bad_path", "A file path is required.");
  if (value.startsWith("-")) {
    throw new HttpError(400, "bad_path", `A file path must not start with '-': ${value}.`);
  }
  if (path.isAbsolute(value)) {
    throw new HttpError(
      400,
      "bad_path",
      `A file path must be relative to the repository: ${value}.`,
    );
  }
  const rel = path.relative(root, path.resolve(root, value));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(400, "bad_path", `The file path leaves the repository: ${value}.`);
  }
  return rel;
}

/** Rejects a branch name that could be read as an option or that git would never accept. */
function assertRefShape(raw: string): string {
  const value = raw.trim();
  if (!value) throw new HttpError(400, "bad_branch", "A branch name is required.");
  if (value.startsWith("-")) {
    throw new HttpError(400, "bad_branch", `A branch name must not start with '-': ${value}.`);
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected here
  if (FORBIDDEN_REF_CHARS.some((c) => value.includes(c)) || /[\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, "bad_branch", `Not a usable branch name: ${value}.`);
  }
  if (value.includes("..") || value.includes("@{")) {
    throw new HttpError(400, "bad_branch", `Not a usable branch name: ${value}.`);
  }
  return value;
}

/**
 * Resolves a revision the caller named to the commit SHA it points at, or rejects it. Doing the
 * resolution here is what makes the later command line safe: the SHA — not the caller's text —
 * is what git is asked about.
 */
async function resolveRev(root: string, rev: string): Promise<string> {
  const value = rev.trim();
  if (!value || value.startsWith("-")) {
    throw new HttpError(400, "bad_revision", "A revision is required.");
  }
  const run = await runGit(root, ["rev-parse", "--verify", "--quiet", `${value}^{commit}`]);
  const sha = run.stdout.trim();
  if (run.code !== 0 || !sha) {
    throw new HttpError(404, "revision_not_found", `No such commit: ${value}.`);
  }
  return sha;
}

/** The repository root a directory sits in, or null when it is not inside a work tree. */
export async function resolveRepoRoot(dir: string): Promise<string | null> {
  const run = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (run.code !== 0) return null;
  const root = run.stdout.trim();
  return root ? path.resolve(root) : null;
}

function parseCommits(text: string): GitCommit[] {
  return text
    .split(RS)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [
        sha = "",
        shortSha = "",
        author = "",
        email = "",
        date = "",
        committerDate = "",
        subject = "",
        refs = "",
        parents = "",
      ] = record.split(FS);
      return {
        sha,
        shortSha,
        subject,
        author: { name: author, email },
        date,
        committerDate,
        refs: refs
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
        parents: parents.trim() ? parents.trim().split(" ") : [],
      };
    });
}

function isConflict(x: string, y: string): boolean {
  return x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
}

/**
 * `git status --porcelain=v1 -z`: one `<XY> <path>` record per file, NUL-terminated; a rename or
 * a copy carries a second record holding the path it came from (the new path comes first).
 */
function parseStatus(stdout: string): GitStatusFile[] {
  const records = stdout.split("\0");
  const files: GitStatusFile[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const x = record.charAt(0);
    const y = record.charAt(1);
    const filePath = record.slice(3);
    if (!filePath) continue;
    let origPath: string | null = null;
    if (x === "R" || x === "C") {
      const next = records[i + 1];
      if (next) {
        origPath = next;
        i += 1;
      }
    }
    files.push({
      path: filePath,
      origPath,
      index: x,
      worktree: y,
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
      untracked: x === "?" && y === "?",
      conflicted: isConflict(x, y),
    });
  }
  return files;
}

function statusCounts(files: readonly GitStatusFile[]): GitStatusSummary["counts"] {
  return {
    staged: files.filter((f) => f.staged).length,
    unstaged: files.filter((f) => f.unstaged).length,
    untracked: files.filter((f) => f.untracked).length,
    conflicted: files.filter((f) => f.conflicted).length,
  };
}

async function readStatus(root: string): Promise<GitStatusSummary> {
  const stdout = await mustGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    "Reading the working tree status",
  );
  const files = parseStatus(stdout);
  return { files, counts: statusCounts(files) };
}

async function readBranches(root: string, current: string | null): Promise<GitBranch[]> {
  const stdout = await mustGit(
    root,
    ["for-each-ref", `--format=${BRANCH_FIELDS}`, "refs/heads", "refs/remotes"],
    "Reading the branches",
  );
  const branches: GitBranch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [ref = "", name = "", sha = "", upstream = "", date = "", subject = ""] = line.split(FS);
    if (!ref || !name) continue;
    const remote = ref.startsWith("refs/remotes/");
    // `origin/HEAD` is a symbolic pointer at another remote branch, not a branch of its own.
    if (remote && name.endsWith("/HEAD")) continue;
    branches.push({
      name,
      sha,
      remote,
      current: !remote && current !== null && name === current,
      upstream: upstream || null,
      date,
      subject,
    });
  }
  return branches;
}

/** BINARY_RE marks a patch whose body git replaced with a "binary files differ" line. */
const BINARY_RE = /^(Binary files .* differ|GIT binary patch)$/m;

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > 0 ? cut : max), truncated: true };
}

/**
 * Splits a `git show --patch` body into one entry per file, counting the added and removed lines
 * of each so the page can show a `+n −m` without a second command.
 */
export function parsePatchFiles(patch: string): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  let section: string[] | null = null;
  const flush = (lines: string[]) => {
    if (lines.length === 0) return;
    /** The pre-image path (`--- a/…`); null for a file the commit adds. */
    let oldPath: string | null = null;
    /** Set by `rename from` / `copy from` — the only thing that makes `origPath` meaningful. */
    let movedFrom: string | null = null;
    /** The post-image path (`+++ b/…`); null for a file the commit deletes. */
    let newPath: string | null = null;
    let additions = 0;
    let deletions = 0;
    let binary = false;
    let started = false;
    for (const line of lines) {
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        movedFrom = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        // A pure rename prints only these four header lines — no `---`/`+++` pair at all.
        newPath = line.slice("rename to ".length);
      } else if (line.startsWith("--- ")) {
        // `/dev/null` is git's "there was no such file", not a path.
        const value = line.slice(4);
        if (value !== "/dev/null") oldPath = value.replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        const value = line.slice(4);
        if (value !== "/dev/null") newPath = value.replace(/^b\//, "");
      } else if (line.startsWith("@@")) started = true;
      else if (started && line.startsWith("+")) additions += 1;
      else if (started && line.startsWith("-")) deletions += 1;
      if (BINARY_RE.test(line)) binary = true;
    }
    // A deletion has no post-image, so the file is named by the path it had.
    const filePath = newPath ?? oldPath;
    if (filePath) {
      files.push({ path: filePath, origPath: movedFrom, additions, deletions, binary });
    }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (section) flush(section);
      section = [line];
    } else if (section) {
      section.push(line);
    }
  }
  if (section) flush(section);
  return files;
}

async function readHead(root: string): Promise<GitCommit | null> {
  const run = await runGit(root, ["log", "-1", `--pretty=format:${LOG_FIELDS}${RS}`]);
  if (run.code !== 0) return null;
  return parseCommits(run.stdout)[0] ?? null;
}

/** Branch name of HEAD, or null when HEAD is detached or the branch has no commits yet. */
async function readBranchName(root: string): Promise<{ branch: string | null; detached: boolean }> {
  const run = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (run.code === 0) {
    const name = run.stdout.trim();
    return { branch: name || null, detached: false };
  }
  return { branch: null, detached: true };
}

async function summarizeRepo(dir: string, root: string): Promise<GitRepoSummary> {
  const base = { path: dir, root, name: path.basename(root) };
  try {
    const { branch, detached } = await readBranchName(root);
    const head = await readHead(root);
    const status = await readStatus(root);
    const dirty =
      status.counts.staged +
        status.counts.unstaged +
        status.counts.untracked +
        status.counts.conflicted >
      0;
    return { ...base, branch, detached, head, dirty, empty: head === null };
  } catch (err) {
    // One unreadable repository (permissions, a corrupt object store) must not take the scan down.
    return {
      ...base,
      branch: null,
      detached: false,
      head: null,
      dirty: false,
      empty: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Scans the given Workspaces for repositories: each is resolved to its top level, and the roots
 * are deduped (several Workspaces inside one repository are one row). Every candidate is still
 * resolved even when it turns out not to be a repository — that is a normal answer, not a failure.
 */
export async function scanRepos(workspaces: readonly string[]): Promise<GitRepoListResponse> {
  const candidates = [...new Set(workspaces.map((w) => w.trim()).filter(Boolean))].sort();
  const capped = candidates.slice(0, MAX_SCAN);
  const roots = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      const dir = capped[index];
      if (dir === undefined) return;
      const root = await resolveRepoRoot(dir).catch(() => null);
      if (root && !roots.has(root)) roots.set(root, dir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, capped.length) }, worker));
  const repos = await Promise.all(
    [...roots.entries()].map(([root, dir]) => summarizeRepo(dir, root)),
  );
  repos.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  return { repos, scanned: capped.length, skipped: candidates.length - capped.length };
}

/** Everything the page needs about one selected repository. */
export async function readRepoDetail(root: string, dir: string): Promise<GitRepoDetail> {
  const { branch, detached } = await readBranchName(root);
  const head = await readHead(root);
  const status = await readStatus(root);
  const branches = await readBranches(root, branch);
  const remotesRun = await runGit(root, ["remote"]);
  const remotes =
    remotesRun.code === 0
      ? remotesRun.stdout
          .split("\n")
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

  const { upstream, ahead, behind } = await readUpstream(root);

  return {
    path: dir,
    root,
    name: path.basename(root),
    branch,
    detached,
    empty: head === null,
    head,
    upstream,
    ahead,
    behind,
    status,
    branches,
    remotes,
  };
}

/** Upstream distance of the current branch — shared by the Git page's detail read and the alignment pass. */
async function readUpstream(
  root: string,
): Promise<{ upstream: string | null; ahead: number; behind: number }> {
  const upstreamRun = await runGit(root, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const upstream = upstreamRun.code === 0 ? upstreamRun.stdout.trim() : "";
  if (!upstream) return { upstream: null, ahead: 0, behind: 0 };
  const counts = await runGit(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (counts.code !== 0) return { upstream, ahead: 0, behind: 0 };
  const [behindText = "0", aheadText = "0"] = counts.stdout.trim().split(/\s+/);
  return {
    upstream,
    behind: Number.parseInt(behindText, 10) || 0,
    ahead: Number.parseInt(aheadText, 10) || 0,
  };
}

export interface GitLogOptions {
  limit: number;
  skip: number;
  /** Revision to start from (a branch, a tag, a SHA); resolved and substituted before use. */
  ref?: string;
}

export async function readLog(root: string, options: GitLogOptions): Promise<GitLogResponse> {
  const args = [
    "log",
    `--max-count=${options.limit + 1}`,
    `--skip=${options.skip}`,
    "--no-color",
    `--pretty=format:${LOG_FIELDS}${RS}`,
  ];
  if (options.ref) args.push(await resolveRev(root, options.ref));
  // `--` last: after a revision git would otherwise keep reading revisions from the arguments.
  args.push("--");
  const stdout = await mustGit(root, args, "Reading the commit log");
  const commits = parseCommits(stdout);
  return { commits: commits.slice(0, options.limit), hasMore: commits.length > options.limit };
}

export async function readCommit(root: string, rev: string): Promise<GitCommitDetail> {
  const sha = await resolveRev(root, rev);
  const metaStdout = await mustGit(
    root,
    ["show", "-s", "--no-color", `--pretty=format:${LOG_FIELDS}${FS}%b`, sha],
    "Reading the commit",
  );
  const parts = metaStdout.split(FS);
  const body = parts.length > 9 ? parts.slice(9).join(FS) : "";
  const meta = parseCommits(parts.slice(0, 9).join(FS))[0];
  if (!meta) throw new HttpError(404, "revision_not_found", `No such commit: ${rev}.`);
  const patchStdout = await mustGit(
    root,
    ["show", "--no-color", "--format=", "--find-renames", "--patch", sha],
    "Reading the commit's patch",
  );
  const clipped = clip(patchStdout, MAX_PATCH_CHARS);
  return {
    ...meta,
    body: body.trim().slice(0, MAX_BODY_CHARS),
    files: parsePatchFiles(clipped.text),
    patch: clipped.text,
    patchTruncated: clipped.truncated,
  };
}

export interface GitDiffOptions {
  /** Repository-relative path of the file to diff; omitted means the whole change set. */
  file?: string;
  staged?: boolean;
  /** Diff a commit instead of the working tree. */
  ref?: string;
}

export async function readDiff(root: string, options: GitDiffOptions): Promise<GitDiffResponse> {
  const rel = options.file === undefined ? undefined : safePathspec(root, options.file);
  let args: string[];
  let kind: GitDiffResponse["kind"];
  if (options.ref) {
    const sha = await resolveRev(root, options.ref);
    args = ["show", "--no-color", "--format=", "--find-renames", sha, ...(rel ? ["--", rel] : [])];
    kind = "commit";
  } else if (options.staged) {
    args = ["diff", "--no-color", "--cached", ...(rel ? ["--", rel] : [])];
    kind = "staged";
  } else if (rel && (await runGit(root, ["ls-files", "--error-unmatch", "--", rel])).code !== 0) {
    // An untracked file has no index entry to diff against, so it is diffed against emptiness.
    args = ["diff", "--no-color", "--no-index", "--", "/dev/null", rel];
    kind = "untracked";
  } else {
    args = ["diff", "--no-color", ...(rel ? ["--", rel] : [])];
    kind = "unstaged";
  }
  const run = await runGit(root, args);
  // `--no-index` exits 1 for "the two sides differ", which for a diff is success.
  if (run.code !== 0 && run.code !== 1) throw gitFailure("Reading the diff", run);
  const clipped = clip(run.stdout, MAX_PATCH_CHARS);
  return {
    kind,
    path: rel ?? null,
    origPath: null,
    binary: BINARY_RE.test(clipped.text),
    patch: clipped.text,
    truncated: clipped.truncated,
  };
}

/** A remote the caller named, checked against the repository's own list; undefined keeps git's default. */
async function requireRemote(root: string, remote: string | undefined): Promise<string | null> {
  if (remote === undefined || remote.trim() === "") return null;
  const value = remote.trim();
  const run = await runGit(root, ["remote"]);
  const known = run.stdout
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!known.includes(value)) {
    throw new HttpError(400, "unknown_remote", `No remote named ${value} in this repository.`);
  }
  return value;
}

function stagePaths(root: string, files: readonly string[]): string[] {
  const paths = files.map((file) => safePathspec(root, file));
  if (paths.length === 0) throw new HttpError(400, "bad_path", "No files were given.");
  return paths;
}

export async function stageFiles(root: string, files: readonly string[]): Promise<string> {
  const paths = stagePaths(root, files);
  const run = await runGit(root, ["add", "--", ...paths]);
  if (run.code !== 0) throw gitFailure("Staging", run);
  return run.stdout.trim();
}

export async function unstageFiles(root: string, files: readonly string[]): Promise<string> {
  const paths = stagePaths(root, files);
  // No HEAD yet (a repository with no commits): `reset HEAD` has nothing to reset against.
  const hasHead = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  const run = hasHead
    ? await runGit(root, ["reset", "--quiet", "HEAD", "--", ...paths])
    : await runGit(root, ["rm", "--cached", "--quiet", "--force", "--", ...paths]);
  if (run.code !== 0) throw gitFailure("Unstaging", run);
  return run.stdout.trim();
}

export interface GitCommitOptions {
  message: string;
  amend?: boolean;
  /** Commits only these paths, taking their working-tree content (git's pathspec form). */
  files?: readonly string[];
}

export async function createCommit(
  root: string,
  options: GitCommitOptions,
): Promise<{ sha: string; summary: string }> {
  const message = options.message.trim();
  if (!message) throw new HttpError(400, "empty_message", "A commit message is required.");
  const args = ["commit", "-m", message];
  if (options.amend) args.push("--amend");
  const paths = options.files && options.files.length > 0 ? stagePaths(root, options.files) : [];
  if (paths.length > 0) args.push("--only", "--", ...paths);
  // Hooks are the repository's own gates, so they run; a slow one is bounded by COMMIT_TIMEOUT_MS.
  const run = await runGit(root, args, { timeoutMs: COMMIT_TIMEOUT_MS });
  if (run.code !== 0) throw gitFailure("Committing", run);
  const sha = (await mustGit(root, ["rev-parse", "HEAD"], "Reading the new commit")).trim();
  return { sha, summary: run.stdout.trim() };
}

export async function checkoutBranch(root: string, branch: string): Promise<string> {
  const name = assertRefShape(branch);
  const branches = await readBranches(root, null);
  if (!branches.some((b) => !b.remote && b.name === name)) {
    throw new HttpError(404, "branch_not_found", `No branch named ${name} in this repository.`);
  }
  const run = await runGit(root, ["checkout", name], { timeoutMs: CHECKOUT_TIMEOUT_MS });
  if (run.code !== 0) throw gitFailure(`Switching to ${name}`, run);
  return run.stderr.trim() || run.stdout.trim();
}

export async function fetchRemote(root: string, remote?: string): Promise<string> {
  const name = await requireRemote(root, remote);
  const run = await runGit(root, ["fetch", "--prune", ...(name ? [name] : [])], {
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (run.code !== 0) throw gitFailure("Fetching", run);
  return (run.stderr.trim() || run.stdout.trim()).slice(0, MAX_BODY_CHARS);
}

export async function pullBranch(root: string): Promise<string> {
  // `--no-edit` because a merge would otherwise want an editor; the fast-forward case is unaffected.
  const run = await runGit(root, ["pull", "--no-edit"], { timeoutMs: NETWORK_TIMEOUT_MS });
  if (run.code !== 0) throw gitFailure("Pulling", run);
  return (run.stdout.trim() || run.stderr.trim()).slice(0, MAX_BODY_CHARS);
}

export async function pushBranch(
  root: string,
  options: { setUpstream?: boolean } = {},
): Promise<string> {
  const args = ["push"];
  if (options.setUpstream) {
    // Publishing a branch needs somewhere to publish it to: the first remote, which is `origin`
    // in every repository git itself created.
    const remotes = (await runGit(root, ["remote"])).stdout
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    const first = remotes[0];
    if (!first) throw new HttpError(400, "no_remote", "This repository has no remote to push to.");
    const branch = (await readBranchName(root)).branch;
    if (!branch) {
      throw new HttpError(
        400,
        "detached_head",
        "HEAD is not on a branch, so there is nothing to push.",
      );
    }
    args.push("--set-upstream", first, branch);
  }
  const run = await runGit(root, args, { timeoutMs: NETWORK_TIMEOUT_MS });
  if (run.code !== 0) throw gitFailure("Pushing", run);
  return (run.stderr.trim() || run.stdout.trim()).slice(0, MAX_BODY_CHARS);
}

// ---------------------------------------------------------------------------
// Alignment-pass primitives.
//
// The Project timer drives git with no page in front of it, so it needs reads and writes the
// page never asks for: "is this tree mine to touch at all?", "what changed since upstream?",
// "commit this exactly as it stands, and tell me what it was". They live here rather than in
// the timer so every argument still reaches git through the same validated layer, and they
// stay out of the routes because nothing a user clicks should merge or auto-commit.
// ---------------------------------------------------------------------------

/** An unfinished operation in the repository: the tree holds work that is not the timer's to finish. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

/** Markers git leaves in `.git` while an operation is in progress, in report order. */
const OPERATION_MARKERS: ReadonlyArray<readonly [string, GitOperation]> = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/** The unfinished operation in this repository, or null when it is in a normal state. */
async function readOperation(root: string): Promise<GitOperation | null> {
  for (const [marker, operation] of OPERATION_MARKERS) {
    const run = await runGit(root, ["rev-parse", "--git-path", marker]);
    if (run.code !== 0) continue;
    const located = run.stdout.trim();
    if (!located) continue;
    const absolute = path.isAbsolute(located) ? located : path.resolve(root, located);
    try {
      await fs.access(absolute);
      return operation;
    } catch {
      // Absent marker: this is not the operation in progress.
    }
  }
  return null;
}

/** Everything the alignment pass decides from, in one read of the repository. */
export interface GitWorktreeState {
  branch: string | null;
  detached: boolean;
  /** No commits yet: there is no HEAD to merge into, and no upstream to be behind. */
  empty: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Tracked paths with staged or unstaged changes — what stops the pass from merging. */
  trackedChanges: string[];
  /** Untracked paths. They do not block a commit; git itself refuses a merge that would overwrite one. */
  untracked: string[];
  conflicted: string[];
  operation: GitOperation | null;
}

export async function readWorktreeState(root: string): Promise<GitWorktreeState> {
  const { branch, detached } = await readBranchName(root);
  const head = await readHead(root);
  const status = await readStatus(root);
  const { upstream, ahead, behind } = await readUpstream(root);
  const operation = await readOperation(root);
  const paths = (pick: (f: GitStatusFile) => boolean) =>
    status.files.filter(pick).map((f) => f.path);
  return {
    branch,
    detached,
    empty: head === null,
    upstream,
    ahead,
    behind,
    trackedChanges: paths((f) => !f.untracked && !f.conflicted),
    untracked: paths((f) => f.untracked),
    conflicted: paths((f) => f.conflicted),
    operation,
  };
}

/** One file's line counts in a diff, for the auto-commit summary. */
export interface GitNumstatFile {
  path: string;
  additions: number;
  deletions: number;
  /** git prints `-`/`-` for a binary file: it has a change but no line counts. */
  binary: boolean;
}

/** `git diff --cached --numstat` — what is staged right now, one entry per file. */
export async function stagedNumstat(root: string): Promise<GitNumstatFile[]> {
  // --no-renames keeps the record shape fixed (a rename would otherwise print its two paths
  // as extra NUL-terminated fields), which is what lets this stay a three-field parse.
  const stdout = await mustGit(
    root,
    ["diff", "--cached", "--numstat", "--no-renames", "-z"],
    "Reading the staged diff",
  );
  const files: GitNumstatFile[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const [additions = "", deletions = "", ...rest] = record.split("\t");
    const filePath = rest.join("\t");
    if (!filePath) continue;
    const binary = additions === "-" || deletions === "-";
    files.push({
      path: filePath,
      additions: binary ? 0 : Number.parseInt(additions, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletions, 10) || 0,
      binary,
    });
  }
  return files;
}

/** What staging the work tree found. */
export type GitStageWorktreeResult =
  { staged: true; files: GitNumstatFile[] } | { staged: false; reason: "clean" | "operation" };

/**
 * Stages the whole work tree and reports what it contained, so the caller can write a message
 * that describes the commit it is about to make.
 *
 * The rails, all deliberate: `-A` so the commit is exactly the tree the user (or the Agent)
 * left behind, never a subset a timer chose, and `.gitignore` is still honoured. An operation
 * already in progress is refused outright — staging on top of a conflicted merge is how a
 * half-resolved tree becomes someone's history.
 */
export async function stageWorkTree(root: string): Promise<GitStageWorktreeResult> {
  if ((await readOperation(root)) !== null) return { staged: false, reason: "operation" };
  const add = await runGit(root, ["add", "-A"], { timeoutMs: CHECKOUT_TIMEOUT_MS });
  if (add.code !== 0) throw gitFailure("Staging the work tree", add);
  // `diff --cached --quiet` exits 1 when something is staged — how git itself says "there is
  // a commit here" without a second parser for porcelain output.
  const staged = await runGit(root, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { staged: false, reason: "clean" };
  return { staged: true, files: await stagedNumstat(root) };
}

/**
 * Commits what is staged. The repository's own hooks run, so a failing pre-commit hook fails
 * the pass rather than being bypassed; there is no `--amend`, no `--no-verify` and no push.
 */
export async function commitStaged(
  root: string,
  message: string,
): Promise<{ sha: string; output: string }> {
  const commit = await runGit(root, ["commit", "-m", message], { timeoutMs: COMMIT_TIMEOUT_MS });
  if (commit.code !== 0) throw gitFailure("Committing the work tree", commit);
  const sha = (await mustGit(root, ["rev-parse", "HEAD"], "Reading the new commit")).trim();
  return { sha, output: commit.stdout.trim() };
}

/** How far `alignUpstream` got. Every non-`failed` outcome is a normal, reportable answer. */
export type GitAlignOutcome =
  | "up_to_date"
  | "fast_forwarded"
  | "merged"
  | "diverged"
  | "conflicted"
  | "no_upstream"
  | "dirty"
  | "detached"
  | "failed";

export interface GitAlignResult {
  outcome: GitAlignOutcome;
  upstream: string | null;
  ahead: number;
  behind: number;
  output: string;
}

/**
 * Brings the current branch up to date with its upstream, or explains why it did not.
 *
 * `fast-forward` never creates a commit, so it cannot conflict or lose anything; it is the
 * default everywhere this runs. `merge` is for a branch that has genuinely diverged, and a
 * conflict is aborted immediately: leaving a repository mid-merge would hand the next Agent
 * turn a tree full of conflict markers it never asked for. Nothing here pushes.
 */
export async function alignUpstream(
  root: string,
  mode: "fast-forward" | "merge",
): Promise<GitAlignResult> {
  const state = await readWorktreeState(root);
  const base = {
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
  };
  if (state.detached) return { ...base, outcome: "detached", output: "HEAD is detached." };
  if (state.upstream === null)
    return { ...base, outcome: "no_upstream", output: "This branch has no upstream." };
  if (state.behind === 0)
    return {
      ...base,
      outcome: "up_to_date",
      output: `Nothing to bring in from ${state.upstream}.`,
    };
  if (mode === "fast-forward" && state.ahead > 0) {
    return {
      ...base,
      outcome: "diverged",
      output: `${state.ahead} local commit(s) and ${state.behind} upstream commit(s): a fast-forward would discard work, and merging is not what this timer asked for.`,
    };
  }
  if (state.trackedChanges.length > 0 || state.conflicted.length > 0) {
    return {
      ...base,
      outcome: "dirty",
      output: `${state.trackedChanges.length + state.conflicted.length} uncommitted tracked path(s): refusing to merge over them.`,
    };
  }
  const run = await runGit(
    root,
    ["merge", ...(mode === "fast-forward" ? ["--ff-only"] : ["--no-edit"]), "@{u}"],
    { timeoutMs: CHECKOUT_TIMEOUT_MS },
  );
  const output = (run.stdout.trim() || run.stderr.trim()).slice(0, MAX_BODY_CHARS);
  if (run.code === 0) {
    return {
      ...base,
      outcome: mode === "fast-forward" ? "fast_forwarded" : "merged",
      output,
    };
  }
  if ((await readOperation(root)) === "merge") {
    // Restore the tree to exactly what it was before the attempt: a timer that leaves a
    // conflict behind has made the workspace worse than it found it.
    const abort = await runGit(root, ["merge", "--abort"], { timeoutMs: CHECKOUT_TIMEOUT_MS });
    const restored = abort.code === 0;
    return {
      ...base,
      outcome: "conflicted",
      output: `${output}\n\nThe merge was ${restored ? "aborted and the work tree restored" : "left in place (aborting it FAILED — resolve it by hand)"}.`,
    };
  }
  return { ...base, outcome: "failed", output };
}

/**
 * Paths that differ between a base revision and HEAD (three-dot: what this branch added since
 * it forked from the base, i.e. the change set a pull request would carry). `range` is built
 * by the caller from git's own refs, never from user input.
 */
export async function changedPaths(root: string, range: string): Promise<string[]> {
  const stdout = await mustGit(
    root,
    ["diff", "--name-only", "--no-renames", "-z", range],
    "Reading the changed paths",
  );
  return stdout.split("\0").filter(Boolean);
}

/** Commit subjects in a revision range, newest first, for the "what is waiting to land" part of a report. */
export async function commitSubjects(
  root: string,
  range: string,
  limit: number,
): Promise<Array<{ sha: string; subject: string }>> {
  const stdout = await mustGit(
    root,
    ["log", `--max-count=${limit}`, "--no-color", `--pretty=format:%h${FS}%s`, range],
    "Reading the commits",
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split(FS);
      return { sha, subject };
    });
}
