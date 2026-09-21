/**
 * Git: the local repositories under a Project's Workspaces.
 *
 * One body, two layouts. In the right dock (the panel the chat toolbar opens) the repository list
 * collapses into a picker in the panel's one header row and everything under it is a single
 * scrolling column; on `/git` — a deep link kept for the same body — the list is its own card
 * beside the repository.
 *
 * Discovery is the server's: every Workspace of the Project (the directories its Sessions ran in)
 * plus the directories the reader adds here by hand, each resolved to its repository top level so
 * several Workspaces inside one repository are one row. The selected repository shows its branch
 * and upstream distance, a toolbar of fetch / pull / push, and three tabs — the commit log (with
 * one commit's patch on demand), the working tree's changes (stage, unstage, commit), and the
 * branches (switch).
 *
 * Nothing here keeps its own model of a repository. Every mutation bumps a nonce and the pane
 * re-reads the server, so what is on screen is what git last said; the only local state that is
 * not git's is the commit message being typed and which commit or file is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitDiffResponse,
  GitRepoDetail,
  GitRepoSummary,
  GitStatusFile,
} from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { apiErrorText } from "../../lib/api-error";
import { S } from "../../lib/strings";
import { useDocumentTitle } from "../../lib/use-document-title";
import { loadWorkspaceRegistry } from "../../lib/workspace-registry";
import { useProject } from "../../state/project";
import { toneDot, toneInk } from "../../lib/tone";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmModal } from "../../components/ui/confirm-modal";
import { EmptyState } from "../../components/ui/empty-state";
import { Textarea } from "../../components/ui/input";
import { SkeletonList } from "../../components/ui/skeleton";
import { Select } from "../../components/ui/select";
import { Tabs } from "../../components/ui/tabs";
import { toastError, toastInfo, toastSuccess } from "../../components/ui/toast";
import { Truncated } from "../../components/ui/truncated";
import { WorkspaceSelect } from "../chat/workspace-select";

/** Card surface shared by the two panes and by every panel inside the right one. */
const PANE = "rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900";

/** A row of the repository list, or of a file/branch list. */
const ROW = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150";

/**
 * One-shot read keyed by a string. The key carries everything the request depends on, so a
 * response that arrives after the inputs moved on is dropped instead of rendering over the newer
 * one — and a caller never has to write the same cancel bookkeeping per tab.
 */
function useLoad<T>(key: string, load: () => Promise<T>) {
  const [state, setState] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ key, data: null, error: null, loading: true });
  // The loader closes over the current props; only the key decides when it runs.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setState({ key, data: null, error: null, loading: true });
    loadRef.current().then(
      (data) => live && setState({ key, data, error: null, loading: false }),
      (err: unknown) =>
        live && setState({ key, data: null, error: apiErrorText(err), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [key]);
  // A render between the key change and the effect still holds the previous key's answer.
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: !fresh || state.loading,
  };
}

/** A relative-or-absolute timestamp as git wrote it, shortened to the minute. */
function shortDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/** The last segment of a repository-relative path: what a narrow column shows first. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Everything before that segment ("" for a file at the repository root). */
function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * The standalone page (`/git`): the workspace below, with the page's own title block. The route
 * survives as a deep link even though the entry point is the right dock's Git panel.
 */
export function GitPage() {
  useDocumentTitle(S.git.pageTitle);
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-xl font-semibold">{S.git.pageTitle}</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500 dark:text-gray-400">{S.git.pageDesc}</p>
        <div className="mt-4">
          <GitWorkspace variant="page" />
        </div>
      </div>
    </div>
  );
}

/**
 * The right dock's Git panel body. A dock is a column, not a page: the repository list becomes a
 * picker in one header row, and everything under it scrolls as one.
 */
export function GitPanel() {
  return <GitWorkspace variant="panel" />;
}

function GitWorkspace({ variant }: { variant: "page" | "panel" }) {
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;

  /**
   * Directories added here. Session-lived on purpose: the sidebar's Workspace registry is a list
   * this surface does not own, and writing into it would change the sidebar as a side effect of
   * browsing here.
   */
  const [extra, setExtra] = useState<string[]>([]);
  const [nonce, setNonce] = useState(0);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);

  /**
   * The sidebar's registered Workspaces are candidates too — a directory registered there is a
   * Workspace of this Project whether or not a Session ever ran in it.
   */
  const registry = useMemo(
    () => (projectId === null ? [] : loadWorkspaceRegistry(projectId).map((e) => e.path)),
    [projectId],
  );
  const candidates = useMemo(() => [...extra, ...registry], [extra, registry]);

  const key = `${projectId ?? ""}\n${candidates.join("\n")}\n${nonce}`;
  // The Project arrives asynchronously. Before it does there is nothing to ask about, and asking
  // anyway would send an empty project id to a route that has no answer for one.
  const { data, error, loading } = useLoad(key, () =>
    projectId === null
      ? Promise.resolve({ repos: [], scanned: 0, skipped: 0 })
      : api.listGitRepos(projectId, candidates),
  );

  const repos = data?.repos ?? [];
  // A selection that is gone (deleted, or no longer a repository) falls back to the first row
  // rather than leaving the pane empty.
  const selected = repos.find((r) => r.root === selectedRoot) ?? repos[0] ?? null;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  /** A picked directory joins the candidate list; if it is not inside a repository, say so. */
  const addDirectory = (path: string) => {
    if (path === "" || candidates.includes(path)) return;
    setExtra((prev) => [...prev, path]);
    setSelectedRoot(null);
    setPendingCheck(path);
  };
  const [pendingCheck, setPendingCheck] = useState<string | null>(null);
  useEffect(() => {
    if (pendingCheck === null || loading) return;
    if (!repos.some((r) => r.root === pendingCheck || r.path === pendingCheck)) {
      toastInfo(S.git.notARepo(pendingCheck));
    }
    setPendingCheck(null);
  }, [pendingCheck, loading, repos]);

  if (projectId === null) return <SkeletonList rows={4} />;

  if (variant === "panel") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
          <Select
            size="sm"
            className="min-w-0 flex-1"
            aria-label={S.git.repos}
            value={selected?.root ?? ""}
            onChange={(e) => setSelectedRoot(e.target.value)}
          >
            {repos.length === 0 && (
              <option value="">{loading ? S.git.scanning : S.git.noRepos}</option>
            )}
            {repos.map((repo) => (
              <option key={repo.root} value={repo.root}>
                {repo.error !== undefined
                  ? `${repo.name} — ${S.git.readFailed(repo.error)}`
                  : `${repo.name}${repo.dirty ? " ●" : ""}`}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
            {S.git.refresh}
          </Button>
          <AddDirectoryButton projectId={projectId} onPick={addDirectory} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <RepoPane
              key={selected.root}
              variant="panel"
              projectId={projectId}
              repo={selected}
              onChanged={reload}
            />
          ) : (
            <div className="p-4">
              <EmptyState
                title={loading ? S.git.scanning : S.git.noRepos}
                description={loading ? undefined : S.git.noReposHint}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <RepoList
        repos={repos}
        loading={loading}
        error={error}
        scanned={data?.scanned ?? 0}
        skipped={data?.skipped ?? 0}
        selectedRoot={selected?.root ?? null}
        onSelect={setSelectedRoot}
        onRescan={reload}
        onAddDirectory={addDirectory}
        projectId={projectId}
      />
      {selected ? (
        <RepoPane
          key={selected.root}
          variant="page"
          projectId={projectId}
          repo={selected}
          onChanged={reload}
        />
      ) : (
        <div className={`${PANE} p-6`}>
          <EmptyState
            title={loading ? S.git.scanning : S.git.noRepos}
            description={loading ? undefined : S.git.noReposHint}
          />
        </div>
      )}
    </div>
  );
}

/** 「添加目录」: the shared directory browser, opened from a small button in either layout. */
function AddDirectoryButton({
  projectId,
  onPick,
}: {
  projectId: string;
  onPick: (path: string) => void;
}) {
  return (
    <WorkspaceSelect
      projectId={projectId}
      workspace=""
      onChange={onPick}
      fieldLabel={S.git.addDirectory}
      menuHint={S.git.addDirectoryHint}
      trigger={(_open, toggle) => (
        <Button size="sm" variant="ghost" onClick={toggle} title={S.git.addDirectory}>
          {S.git.addDirectory}
        </Button>
      )}
    />
  );
}

/** Left pane: the discovered repositories, plus the two ways to change the candidate set. */
function RepoList({
  repos,
  loading,
  error,
  scanned,
  skipped,
  selectedRoot,
  onSelect,
  onRescan,
  onAddDirectory,
  projectId,
}: {
  repos: readonly GitRepoSummary[];
  loading: boolean;
  error: string | null;
  scanned: number;
  skipped: number;
  selectedRoot: string | null;
  onSelect: (root: string) => void;
  onRescan: () => void;
  onAddDirectory: (path: string) => void;
  projectId: string;
}) {
  return (
    <div className={`${PANE} lg:sticky lg:top-0`}>
      <div className="flex items-center gap-1 border-b border-gray-200 px-2.5 py-2 dark:border-gray-800">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{S.git.repos}</h2>
        <Button size="sm" variant="ghost" onClick={onRescan} disabled={loading}>
          {S.git.refresh}
        </Button>
        <AddDirectoryButton projectId={projectId} onPick={onAddDirectory} />
      </div>
      {error !== null && (
        <p className="px-2.5 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {repos.length === 0 && loading && <SkeletonList rows={3} />}
      {repos.length === 0 && !loading && error === null && (
        <p className="px-2.5 py-3 text-xs text-gray-500 dark:text-gray-400">{S.git.noReposHint}</p>
      )}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {repos.map((repo) => {
          const active = repo.root === selectedRoot;
          return (
            <li key={repo.root}>
              <button
                type="button"
                onClick={() => onSelect(repo.root)}
                title={repo.root}
                className={`${ROW} ${
                  active
                    ? "bg-gray-100 dark:bg-gray-800"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800/60"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    repo.error !== undefined
                      ? toneDot.danger
                      : repo.dirty
                        ? toneDot.attention
                        : toneDot.success
                  }`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <Truncated
                    text={repo.name}
                    className="block text-sm font-medium text-gray-900 dark:text-gray-100"
                  />
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                    <Truncated text={repo.branch ?? S.git.detached} className="min-w-0" />
                    {repo.empty && <span>· {S.git.emptyRepo}</span>}
                    {repo.error !== undefined && (
                      <span className="text-red-600 dark:text-red-400">
                        · {S.git.readFailed(repo.error)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {(scanned > 0 || skipped > 0) && (
        <p className="border-t border-gray-100 px-2.5 py-2 text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500">
          {S.git.scanned(scanned)}
          {skipped > 0 ? ` · ${S.git.skipped(skipped)}` : ""}
        </p>
      )}
    </div>
  );
}

type TabKey = "log" | "changes" | "branches";

/** The selected repository's header, its toolbar, and the three tabs. */
function RepoPane({
  projectId,
  repo,
  variant,
  onChanged,
}: {
  projectId: string;
  repo: GitRepoSummary;
  /** `page` is a card beside the repository list; `panel` is a dock column, where the picker
   *  above already names the repository and the pane is the whole width. */
  variant: "page" | "panel";
  onChanged: () => void;
}) {
  const compact = variant === "panel";
  const [tab, setTab] = useState<TabKey>("log");
  const [nonce, setNonce] = useState(0);
  /** The last mutating command's output, shown under the header until the next one. */
  const [opOutput, setOpOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const key = `${repo.path}#${nonce}`;
  const { data, error, loading } = useLoad(key, () => api.getGitRepo(projectId, repo.path));

  /** One toolbar command: run it, show what git printed, then re-read the repository. */
  const run = async (label: string, command: () => Promise<{ output: string }>, done: string) => {
    setBusy(label);
    setOpOutput(null);
    try {
      const res = await command();
      setOpOutput(res.output);
      toastSuccess(done);
      setNonce((n) => n + 1);
      onChanged();
    } catch (err) {
      setOpOutput(apiErrorText(err));
      toastError(apiErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const detail = data;
  const counts = detail?.status.counts;

  return (
    <div className={`${compact ? "" : PANE} min-w-0`}>
      <div
        className={`border-b border-gray-200 dark:border-gray-800 ${
          compact ? "px-2 py-2" : "px-3 py-2.5"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!compact && (
            <h2 className="min-w-0 text-base font-semibold">
              <Truncated text={repo.name} className="max-w-full" />
            </h2>
          )}
          {detail?.branch != null && <Badge tone="brand">{detail.branch}</Badge>}
          {detail?.detached === true && <Badge tone="amber">{S.git.detached}</Badge>}
          {detail?.empty === true && <Badge tone="gray">{S.git.emptyRepo}</Badge>}
          <span className="min-w-0 flex-1" />
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void run(
                S.git.fetch,
                () => api.fetchGitRemote(projectId, { path: repo.path }),
                S.git.opDone,
              )
            }
          >
            {S.git.fetch}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void run(
                S.git.pull,
                () => api.pullGitBranch(projectId, { path: repo.path }),
                S.git.opDone,
              )
            }
          >
            {S.git.pull}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() =>
              void run(
                S.git.push,
                () => api.pushGitBranch(projectId, { path: repo.path, setUpstream: true }),
                S.git.opDone,
              )
            }
          >
            {S.git.push}
          </Button>
        </div>
        <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400" title={repo.root}>
          {repo.root}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
          {detail?.upstream != null ? (
            <span>
              {detail.upstream} · {S.git.aheadBehind(detail.ahead, detail.behind)}
            </span>
          ) : (
            <span>{S.git.noUpstream}</span>
          )}
          {counts !== undefined && (
            <span>
              {S.git.staged} {counts.staged} · {S.git.unstaged} {counts.unstaged} ·{" "}
              {S.git.untracked} {counts.untracked}
              {counts.conflicted > 0 ? ` · ${S.git.conflicted} ${counts.conflicted}` : ""}
            </span>
          )}
          {busy !== null && <span className={toneInk.busy}>{S.git.working}</span>}
        </p>
        {opOutput !== null && (
          <details className="mt-1.5" open>
            <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
              {S.git.opOutput}
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs whitespace-pre-wrap text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
              {opOutput}
            </pre>
          </details>
        )}
      </div>

      <div className="px-3 pt-2">
        <Tabs
          items={[
            { key: "log", label: S.git.tabLog },
            {
              key: "changes",
              label: S.git.tabChanges,
              badge:
                counts !== undefined &&
                counts.staged + counts.unstaged + counts.untracked + counts.conflicted > 0
                  ? S.git.dirty
                  : null,
            },
            { key: "branches", label: S.git.tabBranches },
          ]}
          active={tab}
          onChange={(k) => setTab(k)}
        />
      </div>

      <div className="p-3">
        {error !== null && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {detail === null && loading && <SkeletonList rows={4} />}
        {detail !== null && tab === "log" && <LogTab projectId={projectId} repo={repo} />}
        {detail !== null && tab === "changes" && (
          <ChangesTab
            projectId={projectId}
            repo={repo}
            detail={detail}
            variant={variant}
            onChanged={() => {
              setNonce((n) => n + 1);
              onChanged();
            }}
          />
        )}
        {detail !== null && tab === "branches" && (
          <BranchesTab
            projectId={projectId}
            repo={repo}
            branches={detail.branches}
            remotes={detail.remotes}
            onChanged={() => {
              setNonce((n) => n + 1);
              onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}

const LOG_PAGE = 30;

/** Commit log, newest first, with one commit's patch opened in place. */
function LogTab({ projectId, repo }: { projectId: string; repo: GitRepoSummary }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.listGitLog(projectId, repo.path, {
          limit: LOG_PAGE,
          offset,
        });
        setCommits((prev) => (offset === 0 ? res.commits : [...prev, ...res.commits]));
        setHasMore(res.hasMore);
      } catch (err) {
        setError(apiErrorText(err));
      } finally {
        setLoading(false);
      }
    },
    [projectId, repo.path],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  if (openSha !== null) {
    return (
      <CommitView projectId={projectId} repo={repo} sha={openSha} onBack={() => setOpenSha(null)} />
    );
  }

  return (
    <div>
      {error !== null && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {commits.length === 0 && loading && <SkeletonList rows={5} />}
      {commits.length === 0 && !loading && error === null && (
        <p className="py-4 text-sm text-gray-500 dark:text-gray-400">{S.git.noCommits}</p>
      )}
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {commits.map((commit) => (
          <li key={commit.sha}>
            <button
              type="button"
              onClick={() => setOpenSha(commit.sha)}
              className={`${ROW} hover:bg-gray-50 dark:hover:bg-gray-800/60`}
            >
              <span className="min-w-0 flex-1">
                <Truncated
                  text={commit.subject}
                  className="block text-sm text-gray-900 dark:text-gray-100"
                />
                <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                  {commit.shortSha} · {commit.author.name} · {shortDate(commit.date)}
                </span>
              </span>
              {commit.refs.length > 0 && (
                <span className="flex shrink-0 gap-1">
                  {commit.refs.slice(0, 3).map((ref) => (
                    <Badge key={ref} tone="gray">
                      {ref}
                    </Badge>
                  ))}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <div className="pt-3">
          <Button size="sm" disabled={loading} onClick={() => void load(commits.length)}>
            {loading ? S.git.loading : S.git.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

/** One commit: message, per-file line counts, and the patch. */
function CommitView({
  projectId,
  repo,
  sha,
  onBack,
}: {
  projectId: string;
  repo: GitRepoSummary;
  sha: string;
  onBack: () => void;
}) {
  const { data, error, loading } = useLoad(`${repo.path}#${sha}`, () =>
    api.getGitCommit(projectId, repo.path, sha),
  );
  const detail: GitCommitDetail | null = data;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← {S.git.back}
        </Button>
        <span className="text-sm font-semibold">{S.git.commitDetail}</span>
      </div>
      {error !== null && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {detail === null && loading && <SkeletonList rows={4} />}
      {detail !== null && (
        <div className="min-w-0">
          <p className="text-sm font-medium">{detail.subject}</p>
          {detail.body !== "" && (
            <pre className="mt-1 font-sans text-xs whitespace-pre-wrap text-gray-600 dark:text-gray-300">
              {detail.body}
            </pre>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {detail.sha} · {detail.author.name} &lt;{detail.author.email}&gt; ·{" "}
            {shortDate(detail.date)}
          </p>
          <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
            {detail.files.map((file) => (
              <li
                key={`${file.origPath ?? ""}>${file.path}`}
                className="flex items-center gap-2 py-1 text-xs"
              >
                <Truncated
                  text={file.origPath !== null ? `${file.origPath} → ${file.path}` : file.path}
                  className="min-w-0 flex-1 font-mono"
                />
                {file.binary ? (
                  <span className="shrink-0 text-gray-500 dark:text-gray-400">{S.git.binary}</span>
                ) : (
                  <span className="shrink-0 font-mono">
                    <span className={toneInk.success}>+{file.additions}</span>{" "}
                    <span className={toneInk.danger}>−{file.deletions}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {detail.patchTruncated && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{S.git.patchTruncated}</p>
          )}
          <div className="mt-2">
            <DiffView patch={detail.patch} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Working tree: what git reports, one file's diff, and the commit box. */
function ChangesTab({
  projectId,
  repo,
  detail,
  variant,
  onChanged,
}: {
  projectId: string;
  repo: GitRepoSummary;
  detail: GitRepoDetail;
  variant: "page" | "panel";
  onChanged: () => void;
}) {
  // The dock is a column of its own width, so the two-column split cannot follow the viewport:
  // at 1440px the `lg:` breakpoint still matches inside a 400px panel.
  const compact = variant === "panel";
  const [openFile, setOpenFile] = useState<{ file: GitStatusFile; staged: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);

  const files = detail.status.files;
  const run = async (command: () => Promise<{ output: string }>, done: string) => {
    setBusy(true);
    try {
      await command();
      toastSuccess(done);
      onChanged();
    } catch (err) {
      toastError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`grid items-start gap-3 ${
        compact ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      }`}
    >
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-sm font-semibold">{S.git.tabChanges}</h3>
          <span className="min-w-0 flex-1" />
          {files.length > 0 && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api.stageGitFiles(projectId, {
                      path: repo.path,
                      files: files.map((f) => f.path),
                    }),
                  S.git.stageAll,
                )
              }
            >
              {S.git.stageAll}
            </Button>
          )}
        </div>
        {files.length === 0 ? (
          <EmptyState title={S.git.noChanges} description={S.git.noChangesHint} />
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {files.map((file) => {
              const label = file.conflicted
                ? S.git.conflicted
                : file.untracked
                  ? S.git.untracked
                  : file.staged && file.unstaged
                    ? `${S.git.staged} + ${S.git.unstaged}`
                    : file.staged
                      ? S.git.staged
                      : S.git.unstaged;
              const active =
                openFile !== null &&
                openFile.file.path === file.path &&
                openFile.staged === file.staged;
              return (
                /* A dock column has no room for a second, sticky column, so the diff opens
                   under the row that asked for it — the reader keeps the list in view instead
                   of scrolling to a pane far below the fold. */
                <li key={file.path} className={compact ? "block" : "flex items-center gap-1"}>
                  <div className={compact ? "flex items-center gap-1" : "contents"}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenFile(
                          active ? null : { file, staged: file.untracked ? false : file.staged },
                        )
                      }
                      title={file.path}
                      className={`${ROW} min-w-0 flex-1 ${
                        active
                          ? "bg-gray-100 dark:bg-gray-800"
                          : "hover:bg-gray-50 dark:hover:bg-gray-800/60"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        {compact ? (
                          /* A dock column truncates a full path to nothing useful, and two files
                           under one directory then read alike: the name first, its directory
                           dimmed after it, both with the hover tooltip Truncated adds. */
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <Truncated
                              text={baseName(file.path)}
                              className="shrink font-mono text-xs"
                            />
                            {dirName(file.path) !== "" && (
                              <Truncated
                                text={dirName(file.path)}
                                className="min-w-0 flex-1 font-mono text-xs text-gray-500 dark:text-gray-400"
                              />
                            )}
                          </span>
                        ) : (
                          <Truncated text={file.path} className="block font-mono text-xs" />
                        )}
                        <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                          {label}
                          {file.origPath !== null ? ` ← ${file.origPath}` : ""}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 font-mono text-xs ${
                          file.conflicted
                            ? toneInk.danger
                            : file.staged
                              ? toneInk.success
                              : toneInk.attention
                        }`}
                      >
                        {file.index}
                        {file.worktree}
                      </span>
                    </button>
                    {!file.untracked && !file.conflicted && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title={file.staged ? S.git.unstage : S.git.stage}
                        onClick={() =>
                          void run(
                            () =>
                              file.staged
                                ? api.unstageGitFiles(projectId, {
                                    path: repo.path,
                                    files: [file.path],
                                  })
                                : api.stageGitFiles(projectId, {
                                    path: repo.path,
                                    files: [file.path],
                                  }),
                            file.staged ? S.git.unstage : S.git.stage,
                          )
                        }
                      >
                        {file.staged ? S.git.unstage : S.git.stage}
                      </Button>
                    )}
                    {file.untracked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              api.stageGitFiles(projectId, {
                                path: repo.path,
                                files: [file.path],
                              }),
                            S.git.stage,
                          )
                        }
                      >
                        {S.git.stage}
                      </Button>
                    )}
                  </div>
                  {compact && active && (
                    <div className="mt-1.5">
                      <FileDiff
                        projectId={projectId}
                        repo={repo}
                        file={file}
                        staged={file.untracked ? false : file.staged}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          <Textarea
            label={S.git.commitMessage}
            placeholder={S.git.commitMessagePlaceholder}
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <label className="mt-1.5 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
            {S.git.commitAmend}
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || message.trim() === "" || detail.status.counts.staged === 0}
              onClick={() =>
                void run(async () => {
                  const res = await api.commitGit(projectId, {
                    path: repo.path,
                    message: message.trim(),
                    amend,
                  });
                  setMessage("");
                  setAmend(false);
                  return res;
                }, S.git.committed)
              }
            >
              {S.git.commit}
            </Button>
            {detail.status.counts.staged === 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{S.git.noStaged}</span>
            )}
          </div>
        </div>
      </div>

      {/* Sticky so a file picked far down a long change list still opens where the reader is
          looking, instead of at the top of a column they have already scrolled past. A dock
          column has no second column to stick beside: its diff opens inside the row. */}
      {!compact && (
        <div className="min-w-0 lg:sticky lg:top-4">
          {openFile === null ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">{S.git.selectFile}</p>
          ) : (
            <FileDiff
              projectId={projectId}
              repo={repo}
              file={openFile.file}
              staged={openFile.staged}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** One file's diff, against the index or against HEAD. */
function FileDiff({
  projectId,
  repo,
  file,
  staged,
}: {
  projectId: string;
  repo: GitRepoSummary;
  file: GitStatusFile;
  staged: boolean;
}) {
  const { data, error, loading } = useLoad(`${repo.path}#${file.path}#${staged ? "s" : "w"}`, () =>
    api.getGitDiff(projectId, repo.path, { file: file.path, staged }),
  );
  const diff: GitDiffResponse | null = data;
  const heading = file.untracked
    ? S.git.diffUntracked
    : staged
      ? S.git.diffStaged
      : S.git.diffUnstaged;

  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs text-gray-500 dark:text-gray-400">
        {heading}
        {file.origPath !== null ? ` · ${file.origPath} → ${file.path}` : ""}
      </p>
      {error !== null && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {diff === null && loading && <SkeletonList rows={4} />}
      {diff !== null &&
        (diff.patch === "" ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">{S.git.diffEmpty}</p>
        ) : (
          <>
            {diff.truncated && (
              <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
                {S.git.patchTruncated}
              </p>
            )}
            <DiffView patch={diff.patch} />
          </>
        ))}
    </div>
  );
}

/** Branches: local and remote-tracking, with the switch affordance on the local ones. */
function BranchesTab({
  projectId,
  repo,
  branches,
  remotes,
  onChanged,
}: {
  projectId: string;
  repo: GitRepoSummary;
  branches: readonly GitBranch[];
  remotes: readonly string[];
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = useState<GitBranch | null>(null);
  const [busy, setBusy] = useState(false);

  const checkout = async (branch: GitBranch) => {
    setBusy(true);
    try {
      await api.checkoutGitBranch(projectId, { path: repo.path, branch: branch.name });
      toastSuccess(S.git.branchSwitched(branch.name));
      onChanged();
    } catch (err) {
      toastError(apiErrorText(err));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {branches.map((branch) => (
          <li
            key={`${branch.remote ? "r" : "l"}:${branch.name}`}
            className="flex items-center gap-2"
          >
            <span className="min-w-0 flex-1 py-1.5">
              <Truncated
                text={branch.name}
                className={`block font-mono text-xs ${
                  branch.current ? "font-semibold text-gray-900 dark:text-gray-100" : ""
                }`}
              />
              <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                {branch.sha.slice(0, 8)} · {shortDate(branch.date)} · {branch.subject}
                {branch.upstream !== null ? ` · ↑${branch.upstream}` : ""}
              </span>
            </span>
            {branch.current && <Badge tone="green">{S.git.currentBranch}</Badge>}
            {branch.remote && <Badge tone="gray">{S.git.remoteBranch}</Badge>}
            {!branch.current && !branch.remote && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(branch)}>
                {S.git.switchTo}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {S.git.remotes}: {remotes.length === 0 ? S.git.noRemotes : remotes.join(" · ")}
      </div>
      <ConfirmModal
        open={confirm !== null}
        title={S.git.switchTitle}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm !== null && void checkout(confirm)}
        confirmLabel={S.git.switchTo}
        busy={busy}
      >
        {confirm !== null && <p>{S.git.switchBody(confirm.name)}</p>}
      </ConfirmModal>
    </div>
  );
}

/** A patch, one line per row, with the +/- marks in the success/danger tone. */
function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-xs leading-5 dark:border-gray-800 dark:bg-gray-950">
      {lines.map((line, i) => (
        <div key={i} className={diffLineClass(line)}>
          {line === "" ? " " : line}
        </div>
      ))}
    </pre>
  );
}

/**
 * A patch line's ink. The +/- of a hunk are a judgement about the change (added / removed), so
 * they take the success/danger tone; headers and hunk markers are metadata and stay gray, and the
 * `\ No newline` marker is git's own note, not content.
 */
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "text-gray-500 dark:text-gray-400";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("\\ No newline")
  ) {
    return "text-gray-500 dark:text-gray-400";
  }
  if (line.startsWith("+")) return toneInk.success;
  if (line.startsWith("-")) return toneInk.danger;
  return "text-gray-700 dark:text-gray-300";
}
