/**
 * Alignment timers: a Project's `timers.toml` and the alignment passes it has run.
 *
 * Project-scoped like the Git panel — a timer aligns the repositories the Project's Workspaces
 * sit in, so the panel answers on the draft page too and takes no session props. It is a dock
 * column, not a page: one header row carries the file path, and everything under it is a single
 * scrolling column, because a 320px-wide dock cannot hold a table.
 *
 * Nothing here keeps its own model of a timer. Every save and every run re-reads the server, so
 * what is on screen is what the file and the run table last said; the only local state that is
 * not the server's is the text being edited and which timer's detail is open.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  AlignmentFinding,
  AlignmentRepoReport,
  AlignmentSummary,
  ProjectTimerItem,
  ProjectTimerRunRecord,
  ProjectTimersResponse,
} from "@prismshadow/penguin-server/api";
import * as api from "../../api/endpoints";
import { ApiError } from "../../api/client";
import { subscribeProjectTimerRan } from "../../api/sse";
import { apiErrorText } from "../../lib/api-error";
import { S } from "../../lib/strings";
import { formatDateTime } from "../../lib/format";
import { ICON_SIZE } from "../../lib/icon-scale";
import { toneDot, toneInk, toneStrip, type Tone } from "../../lib/tone";
import { Badge, type BadgeTone } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Chevron } from "../../components/ui/chevron";
import { EmptyState } from "../../components/ui/empty-state";
import { HelpFold } from "../../components/ui/help-fold";
import { Textarea } from "../../components/ui/input";
import { SkeletonList } from "../../components/ui/skeleton";
import { StatusIcon } from "../../components/ui/status-icon";
import { toastError, toastInfo, toastSuccess } from "../../components/ui/toast";
import { Truncated } from "../../components/ui/truncated";
import { useProject } from "../../state/project";
import { findingTone, runStatusTone, starterTimersToml, timerStatusTone } from "./timer-model";

/** A tone names a meaning; a badge names a colour (badge.tsx). The two vocabularies meet here. */
const BADGE_TONE: Record<Tone, BadgeTone> = {
  busy: "green",
  success: "green",
  attention: "amber",
  danger: "red",
  muted: "gray",
};

/** An em dash for a slot the server has nothing for; used often enough to name once. */
const NONE = "—";

interface TimersLoad {
  data: ProjectTimersResponse | null;
  /** Load failure, already localized. */
  error: string | null;
  /** The Project itself is unreadable (404/403): retrying cannot help. */
  denied: boolean;
  loading: boolean;
  reload: () => void;
}

/**
 * Reads the Project's timers, and re-reads them on demand. A refresh keeps the previous answer on
 * screen until the new one lands: the pass that triggers one fires while the reader is looking at
 * the list, and blanking it to a skeleton would read as the panel reloading itself.
 */
function useTimers(projectId: string | null): TimersLoad {
  const [state, setState] = useState<{
    key: string;
    data: ProjectTimersResponse | null;
    error: string | null;
    denied: boolean;
  }>({ key: "", data: null, error: null, denied: false });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (projectId === null) return;
    let live = true;
    api.getProjectTimers(projectId).then(
      (data) => live && setState({ key: projectId, data, error: null, denied: false }),
      (err: unknown) =>
        live &&
        setState({
          key: projectId,
          data: null,
          error: apiErrorText(err),
          denied: err instanceof ApiError && (err.status === 404 || err.status === 403),
        }),
    );
    return () => {
      live = false;
    };
  }, [projectId, nonce]);

  // A render between the project switch and its answer still holds the previous Project's list.
  const fresh = state.key === projectId;
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    denied: fresh && state.denied,
    loading: projectId !== null && !fresh,
    reload,
  };
}

/** The dock's Alignment timers body. */
export function TimersPanel() {
  const { currentProject } = useProject();
  const projectId = currentProject?.projectId ?? null;
  // Owner-only writes, the same gate the schedules tab and the Project dialogs use. The server
  // is the authority (PUT/POST answer 403 for a member and 404 for a non-member); this only
  // decides whether the controls are drawn at all.
  const isOwner = currentProject?.role === "owner";
  const { data, error, denied, loading, reload } = useTimers(projectId);

  /** The timer whose detail is open, and the history fetched for it (null while in flight). */
  const [detail, setDetail] = useState<{
    name: string;
    runs: ProjectTimerRunRecord[] | null;
    error: string | null;
  } | null>(null);
  const detailName = detail?.name ?? null;

  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);

  const loadHistory = useCallback(
    (name: string) => {
      if (projectId === null) return;
      api.listProjectTimerRuns(projectId, name).then(
        (res) =>
          setDetail((prev) => (prev?.name === name ? { name, runs: res.runs, error: null } : prev)),
        (err: unknown) =>
          setDetail((prev) =>
            prev?.name === name ? { name, runs: null, error: apiErrorText(err) } : prev,
          ),
      );
    },
    [projectId],
  );

  // A pass this panel did not start (the schedule, another window) lands here; so does the one it
  // did, through the same event. History is refetched only for the timer actually on screen.
  useEffect(() => {
    if (projectId === null) return;
    return subscribeProjectTimerRan((event) => {
      if (event.projectId !== projectId) return;
      reload();
      if (detailName !== null && event.name === detailName) loadHistory(detailName);
    });
  }, [projectId, reload, loadHistory, detailName]);

  const toggleDetail = (name: string) => {
    if (detailName === name) {
      setDetail(null);
      return;
    }
    setDetail({ name, runs: null, error: null });
    loadHistory(name);
  };

  const runTimer = async (item: ProjectTimerItem, dryRun: boolean) => {
    if (projectId === null) return;
    setBusyName(item.name);
    try {
      const record = await api.runProjectTimer(projectId, item.name, dryRun);
      const status = S.timers.runStatusNames[record.status] ?? record.status;
      const text = dryRun ? S.timers.dryRunFinished(status) : S.timers.runFinished(status);
      // `drift` is the report a timer exists to produce, not a fault; only `failed` is an error.
      if (record.status === "failed") toastError(text);
      else if (record.status === "drift") toastInfo(text);
      else toastSuccess(text);
      reload();
      if (detailName === item.name) loadHistory(item.name);
    } catch (err) {
      toastError(apiErrorText(err));
    } finally {
      setBusyName(null);
    }
  };

  const openEditor = () => {
    setSaveError(null);
    setDraft(data !== null && data.file.exists ? data.file.raw : starterTimersToml());
  };

  const save = async () => {
    if (projectId === null || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.putProjectTimers(projectId, draft);
      // Echo the server's copy back into the editor: what it actually wrote is what the parser
      // read, and the per-entry messages below are computed from that same file.
      setDraft(saved.file.raw);
      toastSuccess(S.common.saved);
      reload();
    } catch (err) {
      // A file the parser cannot interpret at all: nothing was written, and the message says why.
      setSaveError(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-gray-200 px-2 py-1.5 dark:border-gray-800">
        <span
          title={data?.file.path ?? S.timers.filePath}
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400"
        >
          {data?.file.path ?? ""}
        </span>
        <Button size="sm" variant="ghost" onClick={reload} disabled={loading}>
          {S.timers.refresh}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {/* The panel's name lives in the dock's tab strip, so the explanation has to name itself
            (see help-fold.tsx). */}
        <HelpFold label={S.timers.title}>
          {S.timers.desc}
          {!isOwner && <span className="mt-1.5 block">{S.timers.readOnlyHint}</span>}
        </HelpFold>

        {projectId === null || (data === null && loading) ? (
          <SkeletonList rows={3} />
        ) : denied ? (
          <EmptyState title={S.timers.noAccess} />
        ) : data === null ? (
          <EmptyState
            title={error ?? S.common.unknownError}
            action={
              <Button size="sm" onClick={reload}>
                {S.common.retry}
              </Button>
            }
          />
        ) : (
          <>
            {/* Both messages are the parser's own, shown verbatim: they name the field and the
                reason, and re-wording them here would only make them harder to search for. */}
            {data.fileError !== undefined && (
              <div className={`rounded-md border px-2.5 py-2 text-xs ${toneStrip.danger}`}>
                <p className="font-medium">{S.timers.fileError}</p>
                <p className="mt-0.5 font-mono break-words">{data.fileError}</p>
              </div>
            )}
            {data.errors.length > 0 && (
              <div className={`rounded-md border px-2.5 py-2 text-xs ${toneStrip.danger}`}>
                <p className="font-medium">{S.timers.parseErrors}</p>
                <ul className="mt-0.5 space-y-0.5 font-mono">
                  {data.errors.map((entry, index) => (
                    <li key={`${index}-${entry.name}`} className="break-words">
                      {entry.name}: {entry.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.timers.length === 0 ? (
              <EmptyState
                title={S.timers.noTimers}
                description={isOwner ? S.timers.noTimersHint : undefined}
              />
            ) : (
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {data.timers.map((item) => (
                  <TimerRow
                    key={item.name}
                    item={item}
                    owner={isOwner}
                    busy={busyName === item.name}
                    expanded={detailName === item.name}
                    detail={detailName === item.name ? detail : null}
                    onToggle={() => toggleDetail(item.name)}
                    onRun={(dryRun) => void runTimer(item, dryRun)}
                  />
                ))}
              </ul>
            )}

            {isOwner && (
              <div className="rounded-md border border-gray-200 p-2 dark:border-gray-800">
                {draft === null ? (
                  <>
                    {!data.file.exists && (
                      <>
                        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                          {S.timers.fileMissing}
                        </p>
                        <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                          {S.timers.fileMissingHint}
                        </p>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant={data.file.exists ? "ghost" : "secondary"}
                      className="mt-1.5"
                      onClick={openEditor}
                    >
                      {data.file.exists ? S.timers.editFile : S.timers.createStarter}
                    </Button>
                  </>
                ) : (
                  <>
                    <Textarea
                      label={S.timers.fileLabel}
                      info={S.timers.fileInfo}
                      hint={S.timers.fileHint}
                      {...(saveError !== null ? { error: saveError } : {})}
                      value={draft}
                      rows={14}
                      mono
                      size="sm"
                      spellCheck={false}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (saveError !== null) setSaveError(null);
                      }}
                    />
                    <div className="mt-2 flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={saving}
                        onClick={() => void save()}
                      >
                        {saving ? S.common.saving : S.common.save}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => {
                          setDraft(null);
                          setSaveError(null);
                        }}
                      >
                        {S.timers.cancelEdit}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One timer: its state at a glance, its two run buttons, and — folded, because the list is the
 * point of the panel — the last report and the run history. The header is the fold's trigger; the
 * run buttons are siblings of it, never children, since a button inside a button is unclickable.
 */
function TimerRow({
  item,
  owner,
  busy,
  expanded,
  detail,
  onToggle,
  onRun,
}: {
  item: ProjectTimerItem;
  owner: boolean;
  /** This timer's own run request is in flight. */
  busy: boolean;
  expanded: boolean;
  detail: { runs: ProjectTimerRunRecord[] | null; error: string | null } | null;
  onToggle: () => void;
  onRun: (dryRun: boolean) => void;
}) {
  const running = item.running || busy;
  return (
    <li data-testid="timer-row" data-timer-name={item.name}>
      <div className="flex items-start gap-1.5 px-2.5 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded text-left"
        >
          <Chevron
            open={expanded}
            size={ICON_SIZE.chevronDense}
            className="mt-0.5 text-gray-400 dark:text-gray-500"
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <Truncated
                text={item.name}
                className="min-w-0 font-mono text-xs font-medium text-gray-900 dark:text-gray-100"
              />
              <Badge tone={BADGE_TONE[timerStatusTone(item.status)]}>
                {S.timers.statusNames[item.status] ?? item.status}
              </Badge>
              {running && (
                <StatusIcon state="running" size={ICON_SIZE.rowMark} label={S.timers.running} />
              )}
            </span>
            <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">
              {S.timers.nextRun}{" "}
              {item.nextRunAt !== undefined ? formatDateTime(item.nextRunAt) : NONE}
            </span>
            <span className="block text-[11px] text-gray-500 dark:text-gray-400">
              {S.timers.lastRun}{" "}
              {item.lastRunAt !== undefined ? formatDateTime(item.lastRunAt) : NONE}
              {item.lastStatus !== undefined && (
                <>
                  {" · "}
                  <span className={toneInk[runStatusTone(item.lastStatus)]}>
                    {S.timers.runStatusNames[item.lastStatus] ?? item.lastStatus}
                  </span>
                </>
              )}
            </span>
            <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">
              {S.timers.syncLabel} {S.timers.syncNames[item.sync] ?? item.sync}
              {" · "}
              {S.timers.commitLabel} {S.timers.commitNames[item.commit] ?? item.commit}
              {" · "}
              {item.docs ? S.timers.docsOn : S.timers.docsOff}
            </span>
            {/* Why this timer is `invalid` — an unusable entry, or a model reference the
                Project's table cannot resolve. The server's own message, shown as-is. */}
            {item.invalidReason !== undefined && (
              <span className="mt-0.5 block text-[11px] break-words text-red-600 dark:text-red-400">
                {item.invalidReason}
              </span>
            )}
          </span>
        </button>
        {owner && (
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="timer-run"
              disabled={running}
              onClick={() => onRun(false)}
            >
              {S.timers.runNow}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="timer-dry-run"
              title={S.timers.dryRunHint}
              disabled={running}
              onClick={() => onRun(true)}
            >
              {S.timers.dryRun}
            </Button>
          </span>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-2.5 py-2 dark:border-gray-800/60">
          {item.lastSummary !== undefined ? (
            <Report summary={item.lastSummary} />
          ) : (
            <p className="text-[11px] text-gray-500 dark:text-gray-400">{S.timers.noReport}</p>
          )}

          <div className="mt-2">
            <p className="text-[11px] font-medium text-gray-600 dark:text-gray-300">
              {S.timers.history}
            </p>
            {detail === null || (detail.runs === null && detail.error === null) ? (
              <p className="text-[11px] text-gray-400 dark:text-gray-500">{S.common.loading}</p>
            ) : detail.error !== null ? (
              <p className="text-[11px] text-red-600 dark:text-red-400">{detail.error}</p>
            ) : detail.runs !== null && detail.runs.length === 0 ? (
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {S.timers.historyEmpty}
              </p>
            ) : (
              <ul className="mt-0.5 space-y-0.5">
                {(detail.runs ?? []).map((run) => (
                  <HistoryRow key={run.runId} run={run} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** One alignment pass: what it did and what it found, per repository. */
function Report({ summary }: { summary: AlignmentSummary }) {
  const counts = summary.counts;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
        <span>{formatDateTime(summary.at)}</span>
        {summary.dryRun && <Badge tone="brand">{S.timers.dryRunBadge}</Badge>}
        <span>· {S.timers.countsRepos(counts.repos)}</span>
        {counts.findings > 0 && <span>· {S.timers.countsFindings(counts.findings)}</span>}
        {counts.attention > 0 && (
          <span className={toneInk.attention}>· {S.timers.countsAttention(counts.attention)}</span>
        )}
        {counts.merged > 0 && <span>· {S.timers.countsMerged(counts.merged)}</span>}
        {counts.committed > 0 && <span>· {S.timers.countsCommitted(counts.committed)}</span>}
        {counts.failed > 0 && (
          <span className={toneInk.danger}>· {S.timers.countsFailed(counts.failed)}</span>
        )}
      </div>
      {summary.repos.map((repo) => (
        <RepoReport key={repo.path} repo={repo} />
      ))}
    </div>
  );
}

function RepoReport({ repo }: { repo: AlignmentRepoReport }) {
  return (
    <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11px]">
        <span className="font-medium text-gray-800 dark:text-gray-200">{repo.name}</span>
        {repo.branch !== null && (
          <span className="font-mono text-gray-500 dark:text-gray-400">{repo.branch}</span>
        )}
        {(repo.changed.code > 0 || repo.changed.docs > 0) && (
          <span className="text-gray-500 dark:text-gray-400">
            {S.timers.changed(repo.changed.code, repo.changed.docs)}
          </span>
        )}
      </div>
      {/* The service's own message for a repository it could not read: shown as-is. */}
      {repo.error !== undefined && (
        <p className="mt-0.5 text-[11px] break-words text-red-600 dark:text-red-400">
          {repo.error}
        </p>
      )}
      {repo.actions.length > 0 && (
        <div className="mt-1">
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{S.timers.actions}</p>
          <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {repo.actions.map((action, index) => (
              <li key={index} className="break-words">
                {action}
              </li>
            ))}
          </ul>
        </div>
      )}
      {repo.findings.length > 0 && (
        <div className="mt-1">
          <p className="text-[11px] text-gray-400 dark:text-gray-500">{S.timers.findings}</p>
          <ul className="mt-0.5 space-y-1">
            {repo.findings.map((finding, index) => (
              <FindingRow key={index} finding={finding} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: AlignmentFinding }) {
  const tone = findingTone(finding.severity);
  return (
    <li className="flex items-start gap-1.5">
      <span aria-hidden className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[tone]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium text-gray-700 dark:text-gray-200">
          {S.timers.findingKinds[finding.kind] ?? finding.kind}
          {/* The severity in words, so the dot's colour is never the only carrier. */}
          <span className="ml-1 font-normal text-gray-400 dark:text-gray-500">
            {finding.severity === "attention" ? S.timers.severityAttention : S.timers.severityInfo}
          </span>
        </span>
        <span className="block text-[11px] break-words text-gray-500 dark:text-gray-400">
          {finding.detail}
        </span>
        {finding.files !== undefined && finding.files.length > 0 && (
          <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-400 dark:text-gray-500">
            {finding.files.map((file, index) => (
              <li key={index} className="break-words" title={file}>
                {file}
              </li>
            ))}
          </ul>
        )}
      </span>
    </li>
  );
}

function HistoryRow({ run }: { run: ProjectTimerRunRecord }) {
  const attention = run.summary?.counts.attention ?? 0;
  return (
    <li className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
      <span className={`shrink-0 ${toneInk[runStatusTone(run.status)]}`}>
        {S.timers.runStatusNames[run.status] ?? run.status}
      </span>
      <span className="min-w-0 flex-1 truncate">{formatDateTime(run.startedAt)}</span>
      <span className="shrink-0 text-gray-400 dark:text-gray-500">
        {run.trigger === "manual" ? S.timers.triggerManual : S.timers.triggerSchedule}
      </span>
      {run.dryRun && <Badge tone="brand">{S.timers.dryRunBadge}</Badge>}
      {attention > 0 && (
        <span className={`shrink-0 ${toneInk.attention}`}>
          {S.timers.countsAttention(attention)}
        </span>
      )}
    </li>
  );
}
