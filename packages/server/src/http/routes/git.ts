/**
 * The Git page's server surface: `/api/projects/:projectId/git/…`.
 *
 * The page's scope is a Project's Workspaces, so every route is Project-scoped and starts from
 * the same two checks: the caller must reach the Project (a 404 otherwise, without leaking
 * existence), and `path` must be an absolute, existing directory (the shared `requireProjectDir`
 * realpath rule the directory browser and Skill discovery already use). The repository top level
 * is then resolved from that directory — the page never names a root directly.
 *
 * Reads and writes are separate endpoints: GET repos/repo/log/commit/diff only look, and the
 * POSTs — stage, unstage, commit, checkout, fetch, pull, push — are the page's buttons. Every
 * argument that reaches git is validated in the service, not here; this layer only shapes the
 * request into the service's own arguments.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  GitDiffResponse,
  GitLogResponse,
  GitOpResponse,
  GitRepoDetail,
  GitRepoListResponse,
} from "../../api/types.js";
import type { AppEnv } from "../../auth/middleware.js";
import type { AppDeps } from "../../app.js";
import { HttpError } from "../errors.js";
import {
  badRequest,
  optionalBoolean,
  optionalPagingQuery,
  optionalString,
  optionalStringArray,
  readJson,
  requireProjectDir,
  requireString,
  requireValidId,
} from "../validate.js";
import {
  checkoutBranch,
  createCommit,
  fetchRemote,
  pullBranch,
  pushBranch,
  readCommit,
  readDiff,
  readLog,
  readRepoDetail,
  resolveRepoRoot,
  scanRepos,
  stageFiles,
  unstageFiles,
} from "../../services/git-service.js";

/** Commits one page of the log asks for when the caller does not say. */
const DEFAULT_LOG_LIMIT = 50;
/** More than this in one page is a scroll nobody reads and a response nobody wants. */
const MAX_LOG_LIMIT = 200;

export function gitRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Project access, once per request (the 404 without existence leak the other routes use). */
  const requireAccess = (c: Context<AppEnv>) => {
    const projectId = requireValidId(c, "projectId");
    deps.projectService.requireProjectAccess(c.var.user.userId, projectId);
    return projectId;
  };

  /** The repository a Workspace sits in, or the 404 that says it sits in none. */
  const requireRoot = async (dir: string): Promise<string> => {
    const root = await resolveRepoRoot(dir);
    if (!root) throw new HttpError(404, "not_a_repo", `Not inside a git repository: ${dir}.`);
    return root;
  };

  /** The directory a mutating body names, validated the same way a query's `path` is. */
  const bodyDir = async (body: Record<string, unknown>): Promise<string> =>
    await requireProjectDir(requireString(body, "path", { label: "path" }));

  /**
   * GET /repos — the repositories under this Project's Workspaces: the ones its Sessions ran in,
   * plus any directory the page passed as `extra` (the sidebar's Workspace registry lives in the
   * browser, so the page hands those over). An `extra` path that is stale or unreadable is
   * skipped rather than failing the whole scan — it is a candidate, not a requirement.
   */
  app.get("/repos", async (c) => {
    const projectId = requireAccess(c);
    const workspaces = deps.sessionsRepo.listByProject(projectId).map((s) => s.workspace);
    for (const extra of c.req.queries("extra") ?? []) {
      const real = await requireProjectDir(extra).catch(() => null);
      if (real) workspaces.push(real);
    }
    const answer: GitRepoListResponse = await scanRepos(workspaces);
    return c.json(answer);
  });

  /** GET /repo?path= — the selected repository: HEAD, upstream distance, status, branches, remotes. */
  app.get("/repo", async (c) => {
    requireAccess(c);
    const dir = await requireProjectDir(c.req.query("path"));
    const root = await requireRoot(dir);
    const answer: GitRepoDetail = await readRepoDetail(root, dir);
    return c.json(answer);
  });

  /** GET /log?path=&offset=&limit=&ref= — one page of the commit log, newest first. */
  app.get("/log", async (c) => {
    requireAccess(c);
    const dir = await requireProjectDir(c.req.query("path"));
    const paging = optionalPagingQuery(c) ?? { offset: 0, limit: DEFAULT_LOG_LIMIT };
    if (paging.limit > MAX_LOG_LIMIT) {
      throw badRequest(`limit must be at most ${MAX_LOG_LIMIT}.`);
    }
    const root = await requireRoot(dir);
    const ref = optionalString({ ref: c.req.query("ref") }, "ref");
    const answer: GitLogResponse = await readLog(root, {
      limit: paging.limit,
      skip: paging.offset,
      ...(ref ? { ref } : {}),
    });
    return c.json(answer);
  });

  /** GET /commit?path=&ref= — one commit: message body, per-file line counts, and its patch. */
  app.get("/commit", async (c) => {
    requireAccess(c);
    const dir = await requireProjectDir(c.req.query("path"));
    const ref = c.req.query("ref");
    if (!ref) throw badRequest("ref is required.");
    const root = await requireRoot(dir);
    return c.json(await readCommit(root, ref));
  });

  /** GET /diff?path=&file=&staged=&ref= — one file against the index, or one commit's patch. */
  app.get("/diff", async (c) => {
    requireAccess(c);
    const dir = await requireProjectDir(c.req.query("path"));
    const root = await requireRoot(dir);
    const file = c.req.query("file");
    const ref = c.req.query("ref");
    const staged = c.req.query("staged") === "1" || c.req.query("staged") === "true";
    const answer: GitDiffResponse = await readDiff(root, {
      ...(file ? { file } : {}),
      staged,
      ...(ref ? { ref } : {}),
    });
    return c.json(answer);
  });

  /** POST /stage — add the given paths to the index. */
  app.post("/stage", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const files = optionalStringArray(body, "files", "files") ?? [];
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await stageFiles(root, files) };
    return c.json(answer);
  });

  /** POST /unstage — take the given paths back out of the index. */
  app.post("/unstage", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const files = optionalStringArray(body, "files", "files") ?? [];
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await unstageFiles(root, files) };
    return c.json(answer);
  });

  /**
   * POST /commit — commit what is staged. The message is the only content the caller supplies:
   * staging is its own button, so "commit" cannot quietly pick up files the user did not choose.
   */
  app.post("/commit", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const message = requireString(body, "message", { label: "message", maxLen: 10_000 });
    const amend = optionalBoolean(body, "amend") === true;
    const root = await requireRoot(dir);
    const { sha, summary } = await createCommit(root, { message, amend });
    const answer: GitOpResponse = { output: summary, sha };
    return c.json(answer);
  });

  /** POST /checkout — switch HEAD to a branch that already exists in this repository. */
  app.post("/checkout", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const branch = requireString(body, "branch", { label: "branch", maxLen: 255 });
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await checkoutBranch(root, branch) };
    return c.json(answer);
  });

  /** POST /fetch — update remote-tracking branches. */
  app.post("/fetch", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const remote = optionalString(body, "remote", { label: "remote", maxLen: 255 });
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await fetchRemote(root, remote) };
    return c.json(answer);
  });

  /** POST /pull — bring the current branch up to date with its upstream. */
  app.post("/pull", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await pullBranch(root) };
    return c.json(answer);
  });

  /** POST /push — publish the current branch; `setUpstream` gives it an upstream first. */
  app.post("/push", async (c) => {
    requireAccess(c);
    const body = await readJson(c);
    const dir = await bodyDir(body);
    const setUpstream = optionalBoolean(body, "setUpstream") === true;
    const root = await requireRoot(dir);
    const answer: GitOpResponse = { output: await pushBranch(root, { setUpstream }) };
    return c.json(answer);
  });

  return app;
}
