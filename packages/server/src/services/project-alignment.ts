/**
 * The Project timer's alignment pass: what it looks at, what it may change, and why.
 *
 * WHAT THIS IS. One pass over a Project's repositories that (1) commits what the work tree
 * holds, (2) brings each branch up to date with its upstream, and (3) reports where the
 * documents, the commits and the code disagree. It is the scheduled, unattended half of what
 * an Agent does interactively — and the report it produces is the input to that Agent turn
 * when a timer asks for one.
 *
 * WHAT THE FIELD DOES, AND WHAT WAS TAKEN FROM IT. The design is a synthesis of the products
 * that already solve neighbouring slices; each rule below names the one it came from.
 * - TRIGGER. Swimm, driftdev.sh and the Claude Code GitHub Action all hang doc/code checks off
 *   pull-request events; scheduled runs are the full-audit case (Archyl). A repository's
 *   alignment is not knowable from a PR event alone, because most of the drift happens
 *   between PRs — commits that never left the machine, a branch quietly falling behind. Hence
 *   a timer, with the PR event left to the existing surfaces.
 * - DETERMINISTIC FIRST. driftdev.sh is explicit that its checks involve "no model", and
 *   Swimm's Doc Rules are pure regex. Anything decidable from the repository — does the path
 *   in this document exist, did the change set touch code without touching docs, has this
 *   branch diverged — is decided here, in code, and never handed to a model. The model gets
 *   the residue that is genuinely semantic, and gets it with the evidence already attached.
 * - EVIDENCE, NOT PROSE. The findings carry `file:line`-shaped paths rather than a paragraph,
 *   the form every one of these tools converged on (driftdev.sh's file:line output, CodeRabbit
 *   annotations, Claude Code Review's evidence requirement). A finding nobody can navigate to
 *   is a finding nobody acts on.
 * - WARN, DO NOT BLOCK. Danger's own culture page, CodeRabbit's default-warning rollout, and
 *   the LLM reviewers' "report P0/P1 only" rules are all the same lesson: a check that fires
 *   on everything gets turned off. Nothing here blocks anything — the pass cannot fail a build
 *   by design, it reports, and `attention` findings are what a timer may hand to an Agent.
 * - DOC↔CODE COUPLING IS DECLARED, NOT GUESSED. This is why the classification below is a
 *   plain path rule and not a model's opinion about whether a document "looks stale".
 *
 * KNOWN LIMITS, WRITTEN DOWN ON PURPOSE (the failure modes these tools document about
 * themselves): the reference check proves a path EXISTS, not that the prose around it is still
 * true; a code-to-docs mapping is deliberately absent, so "code changed without docs" is a
 * whole-repository observation and cannot say *which* document is stale; there is no memory
 * across runs, so a finding repeats until it is fixed; and the change-set window depends on an
 * upstream existing, which the report states rather than papers over.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AlignmentFinding,
  AlignmentFindingKind,
  AlignmentFindingSeverity,
  AlignmentRepoReport,
  AlignmentSummary,
  ProjectTimerCommitMode,
  ProjectTimerSyncMode,
} from "../api/types.js";
import {
  alignUpstream,
  changedPaths,
  commitStaged,
  commitSubjects,
  fetchRemote,
  readWorktreeState,
  scanRepos,
  stageWorkTree,
  type GitNumstatFile,
  type GitWorktreeState,
} from "./git-service.js";

/** Evidence paths one finding carries (the rest is a count — a wall of paths is not a report). */
const MAX_EVIDENCE_FILES = 20;
/** Changed documents one pass opens to check their references. */
const MAX_DOC_FILES_SCANNED = 8;
/** Missing references reported per pass. */
const MAX_MISSING_REFS = 20;
/** A document larger than this is not read for references (generated or vendored prose). */
const MAX_DOC_BYTES = 256 * 1024;
/** Commit subjects listed for the not-yet-landed change set. */
const MAX_COMMIT_SUBJECTS = 10;
/** Directory groups listed in a generated commit message. */
const MAX_COMMIT_GROUPS = 10;

/**
 * Severity per finding kind. The split is the whole point of the field: `info` describes a
 * repository that is simply in a normal state (nothing pushed yet, nothing to bring in), while
 * `attention` means a person or an Agent should look — and only those can trigger a hand-off.
 */
const FINDING_SEVERITY: Record<AlignmentFindingKind, AlignmentFindingSeverity> = {
  dirty_worktree: "attention",
  operation_in_progress: "info",
  detached: "info",
  no_upstream: "info",
  diverged: "attention",
  merge_conflict: "attention",
  sync_failed: "attention",
  code_without_docs: "attention",
  docs_without_code: "info",
  broken_doc_refs: "attention",
  commits_not_landed: "info",
  read_failed: "attention",
};

/** What one pass is asked to do; every field comes from the timer's declaration. */
export interface AlignmentOptions {
  /**
   * The Project's Session Workspaces. Repositories are discovered from these and only these —
   * the Git panel's own input, so the two surfaces can never disagree about what a Project's
   * repositories are, and a timer cannot be pointed at a directory the Project never used.
   */
  workspaces: readonly string[];
  sync: ProjectTimerSyncMode;
  commit: ProjectTimerCommitMode;
  docs: boolean;
  /** Report only: nothing is committed and nothing is merged. */
  dryRun: boolean;
  /** The timer's name, for the auto-commit trailer. */
  timerName: string;
  now: () => number;
}

/** A document, by extension or by the directory it lives in. */
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const DOC_DIR = /^(docs?|changelog|design|specs|\.agents)\//;
/** Generated output and lockfiles: their changes say nothing about documentation drift. */
const GENERATED = /(^|\/)(node_modules|dist|build|out|coverage|\.next)\//;
const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/;

/** Which side of the doc/code split a changed path falls on ("noise" is neither). */
export function classifyPath(relPath: string): "doc" | "code" | "noise" {
  if (GENERATED.test(relPath) || LOCKFILE.test(relPath)) return "noise";
  if (DOC_FILE.test(relPath) || DOC_DIR.test(relPath)) return "doc";
  return "code";
}

function finding(
  kind: AlignmentFindingKind,
  detail: string,
  files?: readonly string[],
): AlignmentFinding {
  const evidence = files && files.length > 0 ? [...files].slice(0, MAX_EVIDENCE_FILES) : undefined;
  return {
    kind,
    severity: FINDING_SEVERITY[kind],
    detail,
    ...(evidence ? { files: evidence } : {}),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The directory a committed file is grouped under. Two segments when there are at least three,
 * so a monorepo reads `packages/server` rather than one `packages` bucket holding everything.
 */
function commitGroup(relPath: string): string {
  const segments = relPath.split("/");
  if (segments.length >= 3) return segments.slice(0, 2).join("/");
  return segments.length >= 2 ? segments[0]! : ".";
}

/**
 * The auto-commit message, generated from the diff itself.
 *
 * Deterministic on purpose: a timer that runs unattended must not need a model to say what it
 * just committed, and the commit is honest about its own origin. The subject follows the
 * repository's Conventional Commits convention, the body groups the files by their first
 * directory so the shape of the change is legible without opening it.
 */
export function summarizeCommit(
  files: readonly GitNumstatFile[],
  timerName: string,
  at: string,
): string {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const groups = new Map<string, { files: number; additions: number; deletions: number }>();
  for (const file of files) {
    const group = groups.get(commitGroup(file.path)) ?? { files: 0, additions: 0, deletions: 0 };
    group.files += 1;
    group.additions += file.additions;
    group.deletions += file.deletions;
    groups.set(commitGroup(file.path), group);
  }
  const width = Math.max(...[...groups.keys()].map((k) => k.length), 0);
  const body = [...groups.entries()]
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .slice(0, MAX_COMMIT_GROUPS)
    .map(
      ([name, g]) =>
        `${name.padEnd(width)}  ${String(g.files).padStart(3)} file(s)  +${g.additions} −${g.deletions}`,
    )
    .join("\n");
  const binary = files.filter((f) => f.binary).length;
  return [
    `chore(timer): checkpoint ${files.length} file(s) (+${additions} −${deletions})`,
    "",
    body,
    ...(binary > 0 ? ["", `${binary} binary file(s) not counted in the line totals.`] : []),
    "",
    `Auto-committed by the "${timerName}" Project timer at ${at}.`,
  ].join("\n");
}

/** A reference found in a document, with the line it sits on. */
interface DocRef {
  value: string;
  line: number;
}

/**
 * The references a changed document makes that could name a path in this repository:
 * Markdown link targets and inline code spans. Prose and anchors are not references; a span
 * without a slash, or whose last segment has no extension, is prose about a concept rather
 * than a path, and guessing at those is how this check would earn its reputation for noise.
 */
function extractRefs(text: string): DocRef[] {
  const refs: DocRef[] = [];
  const patterns = [/\]\(([^)\s]+)\)/g, /`([^`\n]+)`/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      const index = match.index ?? 0;
      if (!value || !looksLikePath(value)) continue;
      refs.push({ value, line: text.slice(0, index).split("\n").length });
    }
  }
  return refs;
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false; // http:, https:, mailto:, data:
  if (!trimmed.includes("/")) return false;
  const last = trimmed.split("/").pop() ?? "";
  return last.includes(".");
}

/** A reference without its anchor or query string; null when nothing path-shaped is left. */
function stripAnchor(value: string): string | null {
  const trimmed = value.trim().split("#")[0]?.split("?")[0] ?? "";
  return trimmed === "" ? null : trimmed;
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

/**
 * References in the given documents that point at nothing. Each result is `path:line → target`,
 * the shape a reader can jump to. Only existence is checked — see this module's KNOWN LIMITS.
 */
async function missingDocRefs(root: string, docs: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const rel of docs) {
    if (missing.length >= MAX_MISSING_REFS) break;
    let text: string;
    try {
      const absolute = path.join(root, rel);
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_DOC_BYTES) continue;
      text = await fs.readFile(absolute, "utf8");
    } catch {
      continue; // Deleted, unreadable, or a directory: not this check's business.
    }
    const dir = path.dirname(path.join(root, rel));
    for (const ref of extractRefs(text)) {
      if (missing.length >= MAX_MISSING_REFS) break;
      const target = stripAnchor(ref.value);
      if (target === null) continue;
      // A document may address the repository root or its own directory; both are normal, and
      // a target that resolves under either is not missing.
      const resolved =
        (await exists(path.resolve(dir, target))) || (await exists(path.resolve(root, target)));
      if (!resolved) missing.push(`${rel}:${ref.line} → ${target}`);
    }
  }
  return missing;
}

/** The repositories this pass walks: the ones the Project's Workspaces sit in. */
async function resolveTargets(
  options: AlignmentOptions,
): Promise<Array<{ root: string; path: string }>> {
  const { repos } = await scanRepos(options.workspaces);
  return repos.map((repo) => ({ root: repo.root, path: repo.path }));
}

/**
 * The change set the drift checks read: everything on this branch that has not landed
 * upstream, plus everything this pass just committed. With no upstream there is no
 * PR-shaped change set at all — the report says so rather than inventing one.
 */
async function driftWindow(
  root: string,
  state: GitWorktreeState,
  committedPaths: readonly string[],
): Promise<{ paths: string[]; base: string | null }> {
  const paths = new Set<string>(committedPaths);
  if (state.upstream !== null) {
    for (const p of await changedPaths(root, `${state.upstream}...HEAD`).catch(() => [])) {
      paths.add(p);
    }
    return { paths: [...paths], base: state.upstream };
  }
  for (const p of await changedPaths(root, "HEAD").catch(() => [])) paths.add(p);
  return { paths: [...paths], base: null };
}

/** One repository's pass. Never throws: a failure here is a finding on this repository. */
async function alignRepo(
  target: { root: string; path: string },
  options: AlignmentOptions,
  at: string,
): Promise<AlignmentRepoReport> {
  const { root } = target;
  const actions: string[] = [];
  const findings: AlignmentFinding[] = [];
  let merged = 0;
  let committed = 0;
  let changed = { code: 0, docs: 0 };

  const report = (state: GitWorktreeState | null, error?: string): AlignmentRepoReport => ({
    path: target.path,
    root,
    name: path.basename(root),
    branch: state?.branch ?? null,
    upstream: state?.upstream ?? null,
    ahead: state?.ahead ?? 0,
    behind: state?.behind ?? 0,
    actions,
    findings,
    changed,
    merged,
    committed,
    ...(error !== undefined ? { error } : {}),
  });

  let state: GitWorktreeState;
  try {
    state = await readWorktreeState(root);
  } catch (err) {
    findings.push(finding("read_failed", `Could not read this repository: ${messageOf(err)}`));
    return report(null, messageOf(err));
  }

  // An operation in progress is not this pass's to finish: committing on top of a conflicted
  // merge, or merging over a rebase, would make the workspace worse than it was found.
  if (state.operation !== null) {
    findings.push(
      finding("operation_in_progress", `A ${state.operation} is in progress: leaving this alone.`),
    );
    return report(state);
  }

  // 1. Commit what the tree holds. This is also what makes step 2 reachable: a merge is only
  //    attempted on a clean tree, and an Agent's workspace is almost never clean.
  const committedPaths: string[] = [];
  const dirtyPaths = [...state.trackedChanges, ...state.untracked];
  if (options.commit === "auto" && dirtyPaths.length > 0) {
    if (options.dryRun) {
      findings.push(
        finding(
          "dirty_worktree",
          `${dirtyPaths.length} uncommitted path(s); a real run would commit them.`,
          dirtyPaths,
        ),
      );
    } else {
      try {
        const staged = await stageWorkTree(root);
        if (staged.staged) {
          const message = summarizeCommit(staged.files, options.timerName, at);
          const { sha } = await commitStaged(root, message);
          committedPaths.push(...staged.files.map((f) => f.path));
          actions.push(`committed ${staged.files.length} file(s) as ${sha.slice(0, 7)}`);
          committed = 1;
          state = await readWorktreeState(root);
        } else if (staged.reason === "operation") {
          findings.push(
            finding("operation_in_progress", "An operation started mid-pass: nothing committed."),
          );
          return report(state);
        }
      } catch (err) {
        // A failing pre-commit hook is the repository's own gate talking: report it, never
        // bypass it with --no-verify.
        findings.push(finding("sync_failed", `Committing failed: ${messageOf(err)}`));
        return report(state);
      }
    }
  } else if (dirtyPaths.length > 0) {
    findings.push(
      finding(
        "dirty_worktree",
        `${dirtyPaths.length} uncommitted path(s) were left as they are.`,
        dirtyPaths,
      ),
    );
  }

  // 2. Sync with upstream.
  if (options.sync !== "none") {
    try {
      await fetchRemote(root);
      actions.push("fetched");
    } catch (err) {
      findings.push(finding("sync_failed", `Fetching failed: ${messageOf(err)}`));
    }
    if (options.sync === "fast-forward" || options.sync === "merge") {
      try {
        const result = await alignUpstream(
          root,
          options.sync === "merge" ? "merge" : "fast-forward",
        );
        switch (result.outcome) {
          case "fast_forwarded":
            actions.push(`fast-forwarded to ${result.upstream}`);
            merged = 1;
            break;
          case "merged":
            actions.push(`merged ${result.upstream}`);
            merged = 1;
            break;
          case "up_to_date":
            actions.push("already up to date");
            break;
          case "diverged":
            findings.push(finding("diverged", result.output));
            break;
          case "conflicted":
            findings.push(finding("merge_conflict", result.output));
            break;
          case "dirty":
            findings.push(finding("dirty_worktree", result.output));
            break;
          case "detached":
            findings.push(finding("detached", result.output));
            break;
          case "no_upstream":
            actions.push("no upstream configured");
            break;
          case "failed":
            findings.push(finding("sync_failed", result.output));
            break;
        }
        state = await readWorktreeState(root);
      } catch (err) {
        findings.push(finding("sync_failed", `Aligning with upstream failed: ${messageOf(err)}`));
      }
    }
  }

  // 3. The drift checks, all deterministic and all read-only.
  if (options.docs) {
    const window = await driftWindow(root, state, committedPaths);
    const code = window.paths.filter((p) => classifyPath(p) === "code");
    const docs = window.paths.filter((p) => classifyPath(p) === "doc");
    changed = { code: code.length, docs: docs.length };
    if (window.base === null) {
      findings.push(
        finding(
          "no_upstream",
          "This branch has no upstream, so there is no not-yet-landed change set to compare; the checks below cover only what this pass committed and what is still uncommitted.",
        ),
      );
    }
    if (window.base !== null && state.ahead > 0) {
      const subjects = await commitSubjects(
        root,
        `${window.base}..HEAD`,
        MAX_COMMIT_SUBJECTS,
      ).catch(() => []);
      if (subjects.length > 0) {
        // The local analogue of an unopened pull request: this is what has not landed yet.
        findings.push(
          finding(
            "commits_not_landed",
            `${state.ahead} commit(s) have not reached ${window.base}: ${subjects.map((c) => c.subject).join(" · ")}`,
          ),
        );
      }
    }
    if (code.length > 0 && docs.length === 0) {
      findings.push(
        finding(
          "code_without_docs",
          `${code.length} code file(s) changed and no document did — this change set may have left the documentation behind.`,
          code,
        ),
      );
    }
    if (docs.length > 0 && code.length === 0) {
      findings.push(
        finding("docs_without_code", `${docs.length} document(s) changed and no code did.`, docs),
      );
    }
    const missing = await missingDocRefs(root, docs.slice(0, MAX_DOC_FILES_SCANNED));
    if (missing.length > 0) {
      findings.push(
        finding(
          "broken_doc_refs",
          `${missing.length} reference(s) in changed documents point at paths that do not exist.`,
          missing,
        ),
      );
    }
  }

  return report(state);
}

/**
 * One alignment pass over the Project's repositories.
 *
 * Repositories are walked in order, not concurrently: they can share a remote, and git is not
 * any faster for being asked to fetch the same thing twice at once. A repository that fails
 * never stops the others — its failure is a finding on itself.
 */
export async function runAlignment(options: AlignmentOptions): Promise<AlignmentSummary> {
  const at = new Date(options.now()).toISOString();
  const targets = await resolveTargets(options);
  const repos: AlignmentRepoReport[] = [];
  for (const target of targets) {
    repos.push(await alignRepo(target, options, at));
  }
  const findings = repos.flatMap((r) => r.findings);
  return {
    at,
    sync: options.sync,
    commit: options.commit,
    dryRun: options.dryRun,
    repos,
    counts: {
      repos: repos.length,
      findings: findings.length,
      attention: findings.filter((f) => f.severity === "attention").length,
      merged: repos.reduce((sum, r) => sum + r.merged, 0),
      committed: repos.reduce((sum, r) => sum + r.committed, 0),
      failed: repos.filter((r) => r.error !== undefined).length,
    },
  };
}

/** The run's status, from what the pass did rather than from what it found. */
export function statusOf(summary: AlignmentSummary): "ok" | "merged" | "drift" | "failed" {
  if (summary.counts.failed > 0) return "failed";
  if (summary.counts.attention > 0) return "drift";
  if (summary.counts.merged > 0 || summary.counts.committed > 0) return "merged";
  return "ok";
}

/**
 * The message a timer hands to an Agent when it finds something: the prompt the Project wrote,
 * then the findings with their evidence. Bounded, because this crosses into a model's context —
 * the counts survive even when the file lists are cut.
 */
export function buildAgentMessage(
  prompt: string,
  summary: AlignmentSummary,
  maxChars = 12_000,
): string {
  const lines = [prompt, "", "## Alignment report", ""];
  for (const repo of summary.repos) {
    const parts = [
      `- **${repo.name}** (\`${repo.root}\`)`,
      repo.branch ? `branch \`${repo.branch}\`` : "detached HEAD",
      repo.upstream
        ? `${repo.ahead} ahead / ${repo.behind} behind \`${repo.upstream}\``
        : "no upstream",
    ];
    lines.push(parts.join(" · "));
    for (const action of repo.actions) lines.push(`  - did: ${action}`);
    for (const item of repo.findings) {
      const evidence = item.files && item.files.length > 0 ? ` (${item.files.join(", ")})` : "";
      lines.push(`  - [${item.severity}] ${item.kind}: ${item.detail}${evidence}`);
    }
    if (repo.error !== undefined) lines.push(`  - error: ${repo.error}`);
  }
  lines.push("", `Run at ${summary.at} (sync=${summary.sync}, commit=${summary.commit}).`);
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[report truncated: ${summary.counts.findings} finding(s) across ${summary.counts.repos} repository(ies)]`;
}
