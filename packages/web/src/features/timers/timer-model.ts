/**
 * The Alignment timers panel's decisions that are not layout: which tone a status carries, and
 * the minimal file offered to a Project that declares none. Pure, so vitest can pin them in the
 * node environment the rest of this package's tests run in.
 */
import type {
  AlignmentFindingSeverity,
  ProjectTimerRunStatus,
  ProjectTimerStatus,
} from "@prismshadow/penguin-server/api";
import type { Tone } from "../../lib/tone";

/**
 * A timer's own state. `active` is the only one that will fire on its own; `invalid` is the only
 * fault (the entry or the model reference it names could not be resolved). Disabled, expired and
 * done are all settled — nothing is waiting on the user, so they recede together.
 */
export function timerStatusTone(status: ProjectTimerStatus): Tone {
  switch (status) {
    case "active":
      return "success";
    case "invalid":
      return "danger";
    case "disabled":
    case "expired":
    case "done":
      return "muted";
  }
}

/**
 * A run's outcome. `ok` and `merged` both finished well (merged means the pass moved a branch);
 * `drift` and `interrupted` are unfinished business rather than faults — drift is the report the
 * timer exists to produce, and an interrupted run's process died before it could say anything.
 */
export function runStatusTone(status: ProjectTimerRunStatus): Tone {
  switch (status) {
    case "ok":
    case "merged":
      return "success";
    case "running":
      return "busy";
    case "drift":
    case "interrupted":
      return "attention";
    case "failed":
      return "danger";
  }
}

/** A finding's severity: only `attention` asks for a look, so `info` recedes. */
export function findingTone(severity: AlignmentFindingSeverity): Tone {
  return severity === "attention" ? "attention" : "muted";
}

/** `yyyy-MM-ddTHH:mm:ss±HH:mm` in the viewer's own zone, which is what the user will edit. */
function localIso(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * The starter offered to a Project with no timer file. The server's own template is not on the
 * wire (only `file.raw` is), so this is the smallest thing the parser accepts: one disabled
 * timer an hour out, which the user then edits. `enabled = false` on purpose — a file saved to
 * try the editor must not start aligning repositories the moment it lands.
 */
export function starterTimersToml(now: Date = new Date()): string {
  const start = new Date(now.getTime() + 3_600_000);
  start.setSeconds(0, 0);
  return (
    "[[timer]]\n" +
    'name = "git-align"\n' +
    "enabled = false\n" +
    `start_at = "${localIso(start)}"\n` +
    'period = "30m"\n'
  );
}
