/**
 * Request-prefix fingerprinting (llm/request-fingerprint.ts): the hash a Request stamps on
 * `request_begin` so a provider prompt-cache miss can be attributed after the fact — did this
 * process move the prefix, or did the provider stop serving it? All pure functions, no I/O.
 */
import { describe, expect, it } from "vitest";
import { fingerprintRequestPrefix } from "../src/llm/request-fingerprint.js";
import {
  assistantText,
  requestBegin,
  sessionMeta,
  toolListReady,
  userText,
} from "../src/omnimessage/index.js";
import type { OmniMessage } from "../src/omnimessage/index.js";

/** A context's meta record: the system prompt and model reference the head hash covers. */
const meta = sessionMeta({
  session_id: "session-1",
  provider: "openai",
  model_id: "gpt-5.6-luna",
  model_context_window: 200000,
  system_prompt: "You are Penguin.",
  agent_state: "/tmp/agent_state",
  workspace: "/tmp/ws",
});

const tools: OmniMessage = toolListReady([]);

describe("head stability (the strict-tier question)", () => {
  it("keeps one head hash while the conversation grows, and moves it when the head is re-assembled", () => {
    const first = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [],
      input: [userText("hello")],
      previous: null,
    });
    const second = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [userText("hello"), assistantText("hi")],
      input: [userText("again")],
      previous: first.serialization,
    });
    const rebuilt = fingerprintRequestPrefix({
      meta: sessionMeta({
        session_id: "session-1",
        provider: "openai",
        model_id: "gpt-5.6-luna",
        model_context_window: 200000,
        system_prompt: "You are Penguin, and this sentence moved the prefix.",
        agent_state: "/tmp/agent_state",
        workspace: "/tmp/ws",
      }),
      records: [tools],
      sent: [userText("hello"), assistantText("hi")],
      input: [userText("again")],
      previous: first.serialization,
    });

    expect(second.detail.prefix_head_hash).toBe(first.detail.prefix_head_hash);
    expect(second.detail.prefix_extends_prev).toBe(true);
    expect(rebuilt.detail.prefix_head_hash).not.toBe(first.detail.prefix_head_hash);
  });
});

describe("prefix comparison", () => {
  it("reports a pure extension, a rewrite of already-sent content, and no verdict on a first Request", () => {
    const first = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [],
      input: [userText("hello")],
      previous: null,
    });
    // The same input without a predecessor: there is nothing to extend, so no flag is stamped.
    expect(first.detail.prefix_extends_prev).toBeUndefined();
    expect("prefix_extends_prev" in first.detail).toBe(false);

    // Re-built rather than reused, so this also pins the timestamp exclusion: `userText` stamps
    // a fresh envelope time, and the wire prefix is unaffected by it.
    const extended = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [userText("hello")],
      input: [userText("again")],
      previous: first.serialization,
    });
    expect(extended.detail.prefix_extends_prev).toBe(true);

    // Already-sent content rewritten (a retry's `[turn_retried]` block is the real case): the
    // provider can at best reuse the prefix that ends before the rewrite.
    const rewritten = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [userText("hello, now with a retry tag")],
      input: [userText("again")],
      previous: extended.serialization,
    });
    expect(rewritten.detail.prefix_extends_prev).toBe(false);
  });
});

describe("sizes and the soft-tier parameter", () => {
  it("counts every fingerprinted record and reports the thinking level only when carried", () => {
    const stamped = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [userText("hello")],
      input: [userText("again")],
      previous: null,
      thinkingLevel: "max",
    });
    expect(stamped.detail.prefix_records).toBe(4);
    expect(stamped.detail.prefix_thinking_level).toBe("max");
    expect(stamped.detail.prefix_chars).toBe(stamped.serialization.length);
    expect(stamped.detail.prefix_hash).toMatch(/^[0-9a-f]{32}$/);

    const unstamped = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [],
      input: [userText("hello")],
      previous: null,
    });
    expect("prefix_thinking_level" in unstamped.detail).toBe(false);
  });
});

describe("request_begin stamping", () => {
  it("carries the fingerprint block on the event, and nothing but the type when none is given", () => {
    const detail = fingerprintRequestPrefix({
      meta,
      records: [tools],
      sent: [],
      input: [userText("hello")],
      previous: null,
    }).detail;
    const stamped = requestBegin(detail);
    expect(stamped.payload.type).toBe("request_begin");
    expect(stamped.payload.prefix_hash).toBe(detail.prefix_hash);
    // An old reader sees the payload it always did when the engine stamps nothing.
    expect(Object.keys(requestBegin().payload)).toEqual(["type"]);
  });
});
