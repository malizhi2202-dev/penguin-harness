/**
 * Request-prefix fingerprinting — the product-side half of a prompt-cache investigation.
 *
 * A provider's prompt cache holds only while a Request's rendered prefix repeats, so "the hit
 * rate dropped" has two opposite explanations: this process moved the prefix (a strict-tier
 * violation: a re-assembled system prompt, a changed toolset, a rewritten message) or the
 * provider stopped serving the cached prefix (eviction, expiry, routing). `token_usage`
 * cannot tell them apart — both read as `cache_read: 0` with `cache_write` equal to the whole
 * input — so the engine stamps this fingerprint on the `request_begin` event that already
 * brackets every Request (see `RequestPrefixDetail` in omnimessage/types.ts).
 *
 * Everything here is pure and synchronous: it runs on the request path, so it does no I/O and
 * holds no state. The engine owns the two pieces of state the comparison needs (the prefix it
 * sent so far and the previous Request's serialization).
 *
 * Scope, deliberately: the fingerprint covers what the engine hands over. AgentHub assembles
 * the actual wire request (protocol conversion, provider parameters) and appends the assistant
 * turns to its own history, so no hash taken here is the provider's cache key — it is an
 * anchor for attributing a miss, not a substitute for one.
 */
import { createHash } from "node:crypto";
import type { RequestPrefixDetail } from "../omnimessage/types.js";
import type { OmniMessage } from "../omnimessage/types.js";
import type { ThinkingLevelName } from "../interfaces/shared.js";

/**
 * Records that form a context's **fixed head**: the session meta (system prompt, model
 * reference) and the tool list. These are the records the strict tier promises to keep
 * byte-fixed for as long as the context lives, which is why they are hashed separately —
 * a head hash that moves mid-context is the product's own doing, not the provider's.
 */
const HEAD_TYPES: ReadonlySet<string> = new Set(["session_meta", "tool_list_ready"]);

function isHeadRecord(msg: OmniMessage): boolean {
  const type = (msg.payload as { type?: unknown } | undefined)?.type;
  return typeof type === "string" && HEAD_TYPES.has(type);
}

/** First 32 hex chars of the sha256 — collision-safe at this scale and short enough to read in a Trace. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/**
 * Serialize a record list for comparison. Only the **payloads** are fingerprinted: the
 * envelope's `timestamp` is harness metadata that never reaches the model (the conversion to
 * AgentHub's UniMessage reads `payload` alone — see `mergeOmniToUniMessage`), so including it
 * would report a prefix rewrite every time the engine re-created a message it had already
 * sent.
 *
 * One payload per line, deliberately NOT one JSON array: `startsWith` is only a valid prefix
 * test over an open-ended string, and a serialized array closes with `]`, so a grown array
 * could never be a prefix of anything. Newline-joining keeps "append a record" exactly equal
 * to "append text". `JSON.stringify` is deterministic here because the builders construct
 * payloads with a fixed key order and the values are plain data.
 */
function serialize(records: readonly OmniMessage[]): string {
  return records.map((msg) => JSON.stringify(msg.payload)).join("\n");
}

export interface PrefixFingerprintArgs {
  /** The context's meta record, when the engine holds one. */
  meta?: OmniMessage;
  /** The context's records as the engine holds them (the tool list, plus whatever a resumption replayed). */
  records: readonly OmniMessage[];
  /** Input already handed to a **committed** Request in this context, in order. */
  sent: readonly OmniMessage[];
  /** This Request's input. */
  input: readonly OmniMessage[];
  /** The previous Request's serialization, or null before this context's first Request. */
  previous: string | null;
  /** The thinking level this Request carries, when it carries one. */
  thinkingLevel?: ThinkingLevelName;
}

export interface RequestPrefixFingerprint {
  /** The fields to stamp on this Request's `request_begin`. */
  detail: RequestPrefixDetail;
  /** The serialization they were taken over — pass it back as the next Request's `previous`. */
  serialization: string;
}

export function fingerprintRequestPrefix(args: PrefixFingerprintArgs): RequestPrefixFingerprint {
  const head = [...(args.meta ? [args.meta] : []), ...args.records.filter(isHeadRecord)];
  const body = [...args.records.filter((msg) => !isHeadRecord(msg)), ...args.sent, ...args.input];
  const serialization = serialize([...head, ...body]);
  const detail: RequestPrefixDetail = {
    prefix_hash: digest(serialization),
    prefix_head_hash: digest(serialize(head)),
    prefix_records: head.length + body.length,
    prefix_chars: serialization.length,
    ...(args.previous !== null
      ? { prefix_extends_prev: serialization.startsWith(args.previous) }
      : {}),
    ...(args.thinkingLevel !== undefined ? { prefix_thinking_level: args.thinkingLevel } : {}),
  };
  return { detail, serialization };
}
