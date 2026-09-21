/**
 * The Alignment timers panel's pure decisions (features/timers/timer-model.ts): the tone a
 * status carries, and the starter file offered to a Project that declares none.
 *
 * The starter has to satisfy the server's parser, which lives in packages/server and is not
 * importable from here (this package's tests are node-only and import server types alone), so it
 * is pinned by the shape that parser requires: the table, its required keys, a disabled timer,
 * and a `start_at` genuinely in the future.
 */
import { describe, expect, it } from "vitest";
import {
  findingTone,
  runStatusTone,
  starterTimersToml,
  timerStatusTone,
} from "../src/features/timers/timer-model";

describe("timer status tones", () => {
  it("flags only invalid as a fault, and only active as healthy", () => {
    expect(timerStatusTone("active")).toBe("success");
    expect(timerStatusTone("invalid")).toBe("danger");
  });

  it("lets every settled state recede together", () => {
    // Disabled, expired and done are all "nothing is waiting on you": one tone, no invented
    // distinction between them.
    expect(timerStatusTone("disabled")).toBe("muted");
    expect(timerStatusTone("expired")).toBe("muted");
    expect(timerStatusTone("done")).toBe("muted");
  });
});

describe("run status tones", () => {
  it("keeps drift and interrupted unfinished rather than failed", () => {
    // Drift is the report a timer exists to produce, and an interrupted run's process died
    // before it could report anything: neither is the pass saying no.
    expect(runStatusTone("drift")).toBe("attention");
    expect(runStatusTone("interrupted")).toBe("attention");
    expect(runStatusTone("failed")).toBe("danger");
  });

  it("separates the two finished-well outcomes from the live one", () => {
    expect(runStatusTone("ok")).toBe("success");
    expect(runStatusTone("merged")).toBe("success");
    expect(runStatusTone("running")).toBe("busy");
  });
});

describe("finding tones", () => {
  it("reserves attention for the severity that asks for a look", () => {
    expect(findingTone("attention")).toBe("attention");
    expect(findingTone("info")).toBe("muted");
  });
});

describe("starterTimersToml", () => {
  const now = new Date("2026-09-21T10:00:00Z");
  const starter = starterTimersToml(now);

  it("declares the one table the parser reads, with the keys it requires", () => {
    expect(starter).toContain("[[timer]]");
    expect(starter).toMatch(/^name = "git-align"$/m);
    expect(starter).toMatch(/^start_at = ".+"$/m);
    expect(starter).toMatch(/^period = "30m"$/m);
  });

  it("is disabled, so saving it starts nothing", () => {
    expect(starter).toMatch(/^enabled = false$/m);
  });

  it("starts in the future, on a whole minute", () => {
    const match = /^start_at = "([^"]+)"$/m.exec(starter);
    expect(match).not.toBeNull();
    const at = new Date(match![1]!);
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.getTime()).toBeGreaterThan(now.getTime());
    expect(at.getSeconds()).toBe(0);
    expect(at.getMilliseconds()).toBe(0);
  });
});
