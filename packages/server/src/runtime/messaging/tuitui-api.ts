/**
 * The Tuitui (推推) wire adapter — the platform half of `tuitui-connector.ts`, behind an
 * injectable transport factory so unit tests substitute fake sockets and a fake fetch and
 * never open real network.
 *
 * Tuitui is 360's enterprise IM. Its robot API is unusually small, and every simplification
 * below is the platform's, not this file's:
 *
 * - **No token exchange.** `appId` and `appSecret` ride in the URL of every call — as
 *   `?auth=<appId>.<appSecret>` on the event socket and as `?appid=…&secret=…` on each HTTP
 *   request. Nothing is minted, nothing expires, nothing is refreshed. The consequence is
 *   worth stating where it is caused: every URL built here is a credential, so no error may
 *   quote one (see `safeUrl` and `fetchErrorText`).
 * - **Every inbound frame is acknowledged.** A frame carrying a top-level `event_id` is
 *   answered with `{"ack": "<event_id>"}` BEFORE it is looked at, and the platform redelivers
 *   anything unacknowledged. Acknowledgement and deduplication are therefore two separate
 *   things that both hang off `event_id`: the ack stops the redelivery, the seen-set makes a
 *   redelivery that already happened harmless.
 * - **The connection is the subscription.** One WebSocket long connection carries every
 *   conversation the robot takes part in; there is no per-chat subscribe frame and no
 *   callback URL to expose.
 * - **A sent message cannot be edited, and an outbound text cannot quote.** Replies land in
 *   the conversation the inbound message came from, which is why the connector packs the chat
 *   id into the `messageId` it hands the bridge (see `tuituiReplyTargetOf`).
 * - **Three conversation shapes ride one API.** A direct chat and a group chat take a `text`
 *   message addressed by `tousers` / `togroups`; a channel (teams) post is addressed by
 *   `toteams` and is the only shape that renders Markdown. Which one a chat id names is
 *   inferred from the id's own shape (see `tuituiRouteOf`) — the platform sends no kind back.
 */
import { WebSocket } from "ws";
import type {
  MessagingAccountInfo,
  MessagingClient,
  MessagingInboundImageData,
  MessagingOutboundFile,
  MessagingSendOptions,
} from "./connector.js";
import { collectUnderCap, sniffImageMime } from "./media.js";

/** The IM host every deployment used so far points at (a binding may override it). */
export const TUITUI_DEFAULT_HOST = "im.example.com";

/** The robot API's TLS port. The platform publishes no other, so this is not configurable. */
export const TUITUI_PORT = 8282;

/** How long one HTTP call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 15_000;

/** How long one inbound media download may take. */
const TRANSFER_TIMEOUT_MS = 30_000;

/**
 * How often the socket is probed with a transport-level ping.
 *
 * This is the liveness check the reference bridge's `websockets` client got for free. There is
 * no pong deadline to go with it: the platform keeps the application-level keepalive, and a
 * socket that stops answering is noticed when it closes or when the next send fails, both of
 * which are already failure paths here.
 */
const PING_INTERVAL_MS = 20_000;

/** The deadline for the socket to reach `open` (the handshake is where bad credentials show). */
export const TUITUI_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The platform's own ceiling on one text message. The bridge already splits replies far below
 * it (MESSAGING_TEXT_CHUNK_CHARS), so this is a backstop rather than the working limit.
 */
export const TUITUI_MAX_TEXT_CHARS = 20_000;

/** Reconnect delays, in order, then the last one forever — the telegram/qq backoff contract. */
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const;

/** How many acknowledged-but-unprocessed event ids to remember before trimming the set. */
const SEEN_EVENT_LIMIT = 2_000;
const SEEN_EVENT_KEEP = 1_000;

/** One credential set (a binding's stored values, or a test request's draft). */
export interface TuituiCredentials {
  appId: string;
  appSecret: string;
  /** IM host, e.g. `im.example.com`. */
  host: string;
}

/** One inbound chat message, reduced from the platform's envelope. */
export interface TuituiInboundEvent {
  /**
   * The conversation to reply into, in the platform's own vocabulary: the peer's account for
   * a direct chat, the numeric `group_id` for a group, and the `teams_<team>_<channel>[_<thread>]`
   * encoding this adapter mints for a channel post (there is no single id in a teams event,
   * and every outbound call needs all three parts back).
   */
  chatId: string;
  /**
   * Whether the chat is a shared space or a one-to-one conversation. A channel post reads as
   * a group: both are places where a reply is seen by whoever else is there.
   */
  chatKind: "direct" | "group";
  /** The platform's id for this message, empty when the event carried none. */
  nativeMessageId: string;
  /** The message's text, already flattened (see `textOfMessageData`); null when it has none. */
  text: string | null;
  /** Image URLs attached to the message, in the order the sender sees them. */
  imageUrls: readonly string[];
  /** Non-image attachments, with the sender's own file name. */
  files: readonly { url: string; name: string }[];
  /** The sender's account, when the event named one. */
  senderAccount?: string;
  /** The sender's display name, when the event named one. */
  senderName?: string;
  /**
   * Whether the message was addressed to this robot — the platform's own `at_me` flag, and
   * only ever set on a group message or a channel post.
   *
   * This is the flag that matters most on this channel. The other four platforms gate a
   * group conversation themselves (Telegram holds messages back under its privacy mode,
   * Feishu and QQ deliver only what mentions the bot), so a group message that arrives at
   * all is one the bot was addressed in. Tuitui delivers EVERY message in every group the
   * robot belongs to, so without this flag the bridge would answer conversations nobody
   * invited it into. The policy lives in the connector (see tuitui-connector.ts), which is
   * where a channel's own notion of "addressed to me" belongs.
   */
  addressed: boolean;
}

/** The platform answered with a non-zero `errcode`. */
export class TuituiApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`Tuitui API error ${errcode}: ${errmsg}`);
    this.name = "TuituiApiError";
  }
}

/** The credential refusal the platform reports for a bad app id or secret. */
export const TUITUI_INVALID_CREDENTIALS_CODE = 40001;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Json, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A URL's own text for an error message, with the credentials stripped.
 *
 * The host and path say which call failed, which is what a reader needs; the query string
 * carries the app secret on every HTTP call and the event socket, so it never travels into a
 * message a user can see or a Trace can record.
 */
function safeUrl(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : `${url.slice(0, cut)}?…`;
}

/** Why a fetch failed, as a short phrase. Never the URL: it carries the secret. */
function fetchErrorText(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timed out";
  if (err instanceof Error && err.message !== "") return err.message;
  return String(err);
}

/** A response body as chunks, cancelled on the way out so an aborted transfer stops reading. */
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * The text a message's `data` object carries, flattened into the one string the model reads.
 *
 * The platform has no caption field: every non-text message type names its own payload
 * instead (`images`, `file`, `voice`, `video`, `link`), and a `mixed` message carries text and
 * images at once. Flattening here rather than in the connector keeps the rule in one place,
 * and it is deliberately the same rendering the reference Python bridge uses, so a
 * conversation moved from that bridge to this one reads the same to the model.
 *
 * A quoted message (`ref`) is appended rather than dropped: the platform's robot API cannot
 * send a reply that quotes, so the quote only ever exists as text, and a user who selected a
 * line and asked about it would otherwise have their question arrive with no subject.
 *
 * Returns null when the message carries no text at all — a channel post does (its `content`),
 * which is why this is called with the event kind's own field.
 */
export function textOfMessageData(data: Json): string | null {
  const kind = stringField(data, "msg_type") ?? "text";
  let text: string | null = null;
  switch (kind) {
    case "text":
      text = typeof data.text === "string" ? data.text : null;
      break;
    case "mixed": {
      const urls = urlsOf(data.images);
      const own = typeof data.text === "string" ? data.text : "";
      text = own !== "" ? own : urls.map(() => "[图片]").join("\n");
      break;
    }
    case "image": {
      const urls = urlsOf(data.images);
      text = urls.length === 0 ? null : urls.map((url) => `[图片] ${url}`).join("\n");
      break;
    }
    case "voice": {
      const url = stringField(data, "voice");
      text = url === undefined ? null : `[语音] ${url}`;
      break;
    }
    case "video": {
      const url = stringField(data, "video");
      text = url === undefined ? null : `[视频] ${url}`;
      break;
    }
    case "file": {
      const file = isRecord(data.file) ? data.file : null;
      const url = file === null ? undefined : stringField(file, "url");
      text = url === undefined ? null : `[文件] ${file?.name ?? "unknown"} : ${url}`;
      break;
    }
    case "link": {
      const link = isRecord(data.link) ? data.link : null;
      const url = link === null ? undefined : stringField(link, "url");
      text =
        url === undefined ? null : `[网页链接]\n${stringField(link ?? {}, "title") ?? ""}\n${url}`;
      break;
    }
    default:
      text = typeof data.text === "string" ? data.text : null;
  }
  // `ref` is documented as an object but arrives as JSON null on messages that quote nothing,
  // which a `?? {}` would not catch.
  const ref = isRecord(data.ref) ? data.ref : null;
  const refId = ref === null ? undefined : stringField(ref, "msgid");
  if (ref !== null && refId !== undefined) {
    const quote = `[引用来自 ${stringField(ref, "user_name") ?? "?"} 的消息]\n${stringField(ref, "content") ?? ""}`;
    return text === null ? quote : `${text}\n\n${quote}`;
  }
  return text;
}

/** The bare URL strings of a `data.images` list (the platform uses objects in teams posts). */
function urlsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "") out.push(entry);
    else if (isRecord(entry)) {
      const url = stringField(entry, "url");
      if (url !== undefined) out.push(url);
    }
  }
  return out;
}

/**
 * The non-image attachments of a message.
 *
 * Two shapes name one, and neither is a superset of the other. A direct or group message
 * carries `msg_type: "file"` with a single `file` object — the platform's own file message. A
 * channel (teams) post carries a `files` ARRAY and no `msg_type` at all, which is why reading
 * only the first shape dropped every attachment posted in a channel: a post is not a file
 * message, it is a post that happens to have one. Both are read, in the platform's order, with
 * duplicates by URL collapsed — a build that sent both would otherwise deliver the same
 * attachment twice.
 */
function filesOfMessageData(data: Json): { url: string; name: string }[] {
  const found: { url: string; name: string }[] = [];
  const push = (url: string | undefined, name: string | undefined): void => {
    if (url === undefined) return;
    const trimmed = url.trim();
    if (trimmed === "" || found.some((entry) => entry.url === trimmed)) return;
    found.push({ url: trimmed, name: name !== undefined && name !== "" ? name : "file" });
  };

  if (Array.isArray(data.files)) {
    for (const entry of data.files) {
      if (isRecord(entry)) push(stringField(entry, "url"), stringField(entry, "name"));
    }
  }
  if (stringField(data, "msg_type") === "file" && isRecord(data.file)) {
    push(stringField(data.file, "url"), stringField(data.file, "name"));
  }
  return found;
}

/** The platform's `at_me` flag, which arrives as a boolean on some builds and `1` on others. */
function atMe(data: Json): boolean {
  const value = data.at_me;
  return value === true || value === 1 || value === "1" || value === "true";
}

/**
 * One conversation's `chat_id`, minted for a channel (teams) post.
 *
 * A teams event names the team, the channel and the thread separately, and every outbound
 * call has to hand all three back; there is no composite id in the payload. Packing them into
 * the chat id is what `tuituiRouteOf` unpacks, and it is the same encoding the reference
 * bridge uses, so a stored `last_chat_id` survives a switch between the two.
 */
function teamsChatId(teamId: string, channelId: string, threadId: string): string {
  const base = `teams_${teamId}_${channelId}`;
  return threadId === "" ? base : `${base}_${threadId}`;
}

/**
 * Reduces one envelope to the connector's inbound shape; null for anything this channel does
 * not answer.
 *
 * Answered events are the three that carry something a user typed: a direct message, a group
 * message and a channel post. `keepalive` is dropped here (the socket already acknowledged
 * it), and so is anything else the platform may add — an unknown event has no text, no image
 * and no file, and inventing one would make the bridge answer a message that does not exist.
 *
 * `at_me` IS read here, into `addressed`, because nothing downstream can reconstruct it: the
 * shared bridge has no mention policy of its own (Feishu resolves one from the mention list and
 * Telegram receives only what the platform already filtered), while this platform pushes every
 * message of every group the robot is in. The event therefore carries the platform's own answer,
 * and the connector — not this reader — is where the unaddressed ones are dropped (see
 * tuitui-connector.ts).
 */
export function normalizeTuituiEvent(frame: unknown): TuituiInboundEvent | null {
  if (!isRecord(frame)) return null;
  const body = isRecord(frame.body) ? frame.body : null;
  if (body === null) return null;
  const event = stringField(body, "event");
  if (event === undefined) return null;
  const data = isRecord(body.data) ? body.data : null;
  const account = stringField(body, "user_account");
  const name = stringField(body, "user_name");
  const sender = {
    ...(account !== undefined ? { senderAccount: account } : {}),
    ...(name !== undefined ? { senderName: name } : {}),
  };

  if (event === "single_chat") {
    if (account === undefined || data === null) return null;
    return {
      // A direct conversation is keyed by the peer's account: that is the address a reply
      // needs, and the only stable name the platform gives the conversation.
      chatId: account,
      chatKind: "direct",
      addressed: true,
      nativeMessageId: nativeMessageIdOf(data),
      text: textOfMessageData(data),
      imageUrls: urlsOf(data.images),
      files: filesOfMessageData(data),
      ...sender,
    };
  }
  if (event === "group_chat") {
    if (data === null) return null;
    const groupId = data.group_id;
    const chatId =
      typeof groupId === "number" && Number.isFinite(groupId)
        ? String(groupId)
        : stringField(data, "group_id");
    if (chatId === undefined) return null;
    return {
      chatId,
      chatKind: "group",
      addressed: atMe(data),
      nativeMessageId: nativeMessageIdOf(data),
      text: textOfMessageData(data),
      imageUrls: urlsOf(data.images),
      files: filesOfMessageData(data),
      ...sender,
    };
  }
  if (event === "teams_post_create" || event === "teams_post_modify") {
    if (data === null) return null;
    const teamId = stringField(data, "team_id");
    const channelId = stringField(data, "channel_id");
    if (teamId === undefined || channelId === undefined) return null;
    const postId = stringField(data, "post_id") ?? "";
    const parentId = stringField(data, "parent_id");
    // A reply post threads under its parent; anything else is its own thread, and "0" is the
    // platform's way of saying there is no parent.
    const threadId = parentId !== undefined && parentId !== "0" ? parentId : postId;
    return {
      chatId: teamsChatId(teamId, channelId, threadId),
      chatKind: "group",
      addressed: atMe(data),
      nativeMessageId: postId,
      text: typeof data.content === "string" ? data.content : null,
      imageUrls: urlsOf(data.images),
      files: filesOfMessageData(data),
      ...sender,
    };
  }
  return null;
}

/** The platform's id for one message: `msgid`, else `post_id`, else empty. */
function nativeMessageIdOf(data: Json): string {
  return stringField(data, "msgid") ?? stringField(data, "post_id") ?? "";
}

/**
 * Where one outbound message goes, given the chat id `normalizeTuituiEvent` minted.
 *
 * The platform takes three different address shapes and nothing in an inbound event says
 * which one to use back, so the id's own shape decides — checked in the order the reference
 * bridge checks: the `teams_` prefix first (a channel id can contain digits), then a
 * 16-digit group id, then a direct chat.
 *
 * The group test is the platform's inference, not a documented rule: group ids are minted as
 * 16 digits, and an id in no such shape is addressed as a direct chat. A group whose id ever
 * arrived in another shape would be answered in the wrong audience, which is why the
 * connector never invents a chat id — it only carries back what an event delivered.
 */
export function tuituiRouteOf(chatId: string): Json {
  if (chatId.startsWith("teams_")) {
    const [, teamId = "", channelId = "", ...rest] = chatId.split("_");
    return {
      toteams: [{ team_id: teamId, channel_id: channelId, parent_id: rest.join("_") }],
    };
  }
  if (/^\d{16}$/.test(chatId)) return { togroups: [chatId] };
  return { tousers: [chatId] };
}

/** The reply anchor packed into the seam's `messageId` (see `tuituiReplyTargetOf`). */
const REPLY_SEPARATOR = "\u0001";

/**
 * The seam's `messageId` for one inbound event.
 *
 * The bridge hands this value back to `replyText`, which the platform cannot do anything
 * with on its own — an outbound text carries no quote and no thread id, so a reply is just a
 * message in the same conversation. Packing the chat id in front is what makes that possible
 * without asking the bridge to remember a second value, and it keeps the native id intact at
 * the tail (which is what dedup compares).
 *
 * `native` is empty when the event carried no id; the packed value then still identifies the
 * conversation, and the bridge treats an empty-tail id as its own business.
 */
export function tuituiMessageIdOf(chatId: string, native: string): string {
  return `${chatId}${REPLY_SEPARATOR}${native}`;
}

/** The chat a packed `messageId` replies into. */
export function tuituiReplyTargetOf(messageId: string): string {
  const cut = messageId.indexOf(REPLY_SEPARATOR);
  return cut === -1 ? messageId : messageId.slice(0, cut);
}

/**
 * Splits one text at the platform's ceiling, preferring a paragraph break, then a line break,
 * then the ceiling itself.
 *
 * The separator newlines are consumed by the cut rather than left at the head of the next
 * chunk, and no `(1/3)` marker is added: the bridge already splits a long answer into separate
 * messages with its own accounting, and a second splitter announcing itself would read as a
 * different conversation than the one the web UI showed.
 */
export function splitTuituiText(text: string, max = TUITUI_MAX_TEXT_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const paragraph = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    const cut = paragraph > 0 ? paragraph : line > 0 ? line : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/**
 * The socket this adapter runs on; injectable so tests never open a connection.
 *
 * `addEventListener` rather than the `onopen`-style properties the reference client used:
 * the two WebSocket implementations this repository already depends on — `ws`'s and
 * undici's — declare that shape identically, so either can be handed in unchanged. `ping` is
 * optional because it is an extension only `ws` has: the default socket sends transport-level
 * pings, and a socket without them rides on the platform's own keepalive frames instead.
 */
export interface TuituiSocket {
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (evt: { data: unknown }) => void): void;
  addEventListener(type: "error", fn: () => void): void;
  addEventListener(type: "close", fn: (evt: { code: number }) => void): void;
  ping?(): void;
  send(data: string): void;
  close(): void;
}

/** One live outbound client for a credential set. */
export interface TuituiBotClient extends MessagingClient {
  /** Puts an emoji reaction on an inbound message — the platform's only receipt gesture. */
  react(chatId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Downloads one inbound image, under the cap the seam's `fetch(maxBytes)` carried in.
   *
   * The URL comes from the message's own payload and is fetched as the platform served it:
   * this API has no per-message download endpoint to authorize against (the four other
   * channels each have one), so an expired URL fails here with the HTTP status — one of the
   * two failure shapes the seam documents, and never a URL in the message.
   */
  fetchImage(url: string, maxBytes: number): Promise<MessagingInboundImageData>;
  /** Downloads one inbound non-image attachment, under the same cap. */
  fetchFile(url: string, maxBytes: number): Promise<Buffer>;
}

export interface TuituiHandlers {
  onMessage(evt: TuituiInboundEvent): void | Promise<void>;
  /** The socket reached `open` (may fire again after an automatic reconnect). */
  onReady?(): void;
  /** The connection failed; `onReady` follows if it comes back. */
  onError?(err: unknown): void;
}

export interface TuituiConnection {
  close(): void;
}

export interface TuituiTransportOpts {
  /** Test hook: the socket the event stream runs on (default: `ws`'s `WebSocket`). */
  createSocket?: (url: string) => TuituiSocket;
  /** Test hook: the reconnect delay after `failures` consecutive failures. */
  retryMs?: (failures: number) => number;
  /** Test hook: the fetch used for HTTP calls and media downloads. */
  fetch?: typeof fetch;
  /** Test hook: the deadline for one message to reach `open`. */
  handshakeTimeoutMs?: number;
  /** Test hook: the application-level ping period. */
  pingIntervalMs?: number;
}

export interface TuituiTransport {
  createClient(creds: TuituiCredentials): TuituiBotClient;
  /**
   * Opens the event stream. Resolves as soon as the connection is constructed and connecting —
   * lifecycle arrives through the handlers, because the socket reconnects on its own and one
   * promise cannot carry a lifecycle. Throws only on a malformed credential set.
   */
  connect(creds: TuituiCredentials, handlers: TuituiHandlers): Promise<TuituiConnection>;
}

/** The event socket's URL. The query string is a credential: never log or quote this. */
export function tuituiSocketUrl(creds: TuituiCredentials): string {
  return `wss://${creds.host}:${TUITUI_PORT}/robot/callback/ws?auth=${creds.appId}.${creds.appSecret}`;
}

/** One HTTP API URL. The query string is a credential: never log or quote this. */
function tuituiApiUrl(creds: TuituiCredentials, path: string): string {
  return `https://${creds.host}:${TUITUI_PORT}/robot${path}?appid=${creds.appId}&secret=${creds.appSecret}`;
}

/** Reads an `errcode` envelope, throwing the platform's own reason for a non-zero one. */
function assertOk(data: unknown, what: string): Json {
  if (!isRecord(data)) throw new Error(`${what} returned a non-JSON body`);
  const code = data.errcode;
  const errmsg = typeof data.errmsg === "string" ? data.errmsg : "";
  if (code === undefined || code === null) return data;
  if (typeof code !== "number" || code !== 0) {
    throw new TuituiApiError(typeof code === "number" ? code : -1, errmsg);
  }
  return data;
}

export function createTuituiTransport(opts: TuituiTransportOpts = {}): TuituiTransport {
  const doFetch = opts.fetch ?? fetch;
  const createSocket = opts.createSocket ?? ((url: string): TuituiSocket => new WebSocket(url));
  const retryMs =
    opts.retryMs ??
    ((failures: number) =>
      RECONNECT_BACKOFF_MS[Math.min(failures, RECONNECT_BACKOFF_MS.length - 1)] ?? 60_000);
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? TUITUI_HANDSHAKE_TIMEOUT_MS;
  const pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;

  /** One JSON call. Every failure carries a readable reason and never a URL. */
  async function apiCall(creds: TuituiCredentials, path: string, payload: Json): Promise<Json> {
    const url = tuituiApiUrl(creds, path);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${safeUrl(url)} failed: ${fetchErrorText(err)}`);
    }
    if (!res.ok) throw new Error(`${safeUrl(url)} failed: HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${safeUrl(url)} returned a non-JSON body`);
    }
    return assertOk(body, safeUrl(url));
  }

  /** Uploads bytes and resolves the media id the platform minted for them. */
  async function uploadMedia(
    creds: TuituiCredentials,
    kind: "file" | "image",
    file: MessagingOutboundFile,
  ): Promise<string> {
    const url = tuituiApiUrl(creds, "/media/upload");
    const form = new FormData();
    form.append("type", kind);
    form.append("media", new Blob([file.data]), file.fileName);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${safeUrl(url)} failed: ${fetchErrorText(err)}`);
    }
    if (!res.ok) throw new Error(`${safeUrl(url)} failed: HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${safeUrl(url)} returned a non-JSON body`);
    }
    const data = assertOk(body, safeUrl(url));
    // The upload answers with `media_id`; the send below names the same value `fid`.
    const nested = isRecord(data.data) ? data.data : null;
    const mediaId =
      stringField(data, "media_id") ??
      (nested === null ? undefined : stringField(nested, "media_id"));
    if (mediaId === undefined) throw new Error("media upload returned no media_id");
    return mediaId;
  }

  /** Downloads one inbound attachment under the bridge's cap. */
  async function downloadCapped(url: string, maxBytes: number, what: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`${what} download failed: ${fetchErrorText(err)}`);
    }
    if (!res.ok || res.body === null)
      throw new Error(`${what} download failed: HTTP ${res.status}`);
    return collectUnderCap(bodyChunks(res.body), maxBytes, what);
  }

  return {
    createClient(creds: TuituiCredentials): TuituiBotClient {
      /** One outbound text, split at the platform's ceiling. */
      const sendChunks = async (
        chatId: string,
        text: string,
        opts: MessagingSendOptions | undefined,
      ): Promise<void> => {
        if (text.trim() === "") return;
        const route = tuituiRouteOf(chatId);
        // Only a channel renders markup (`richtext/markdown`); a direct chat and a group take
        // plain text, so a Markdown request there is answered with the text as written — the
        // seam's own contract for a channel that cannot render it.
        const markup = opts?.markdown === true && "toteams" in route;
        for (const chunk of splitTuituiText(text)) {
          if (markup) {
            try {
              await apiCall(creds, "/message/custom/send", {
                ...route,
                msgtype: "richtext/markdown",
                richtext: { markdown: chunk },
              });
              continue;
            } catch {
              // The seam's contract for a refused render: the SAME text goes out plainly rather
              // than being lost to a formatting failure. A plain send that also fails propagates
              // below, so a real outage is still reported as one.
            }
          }
          await apiCall(creds, "/message/custom/send", {
            ...route,
            msgtype: "text",
            text: { content: chunk },
          });
        }
      };
      const sendFile = async (
        chatId: string,
        kind: "file" | "image",
        file: MessagingOutboundFile,
      ): Promise<void> => {
        if (chatId.startsWith("teams_")) {
          throw new Error("Tuitui channels accept no uploaded attachments");
        }
        const fid = await uploadMedia(creds, kind, file);
        await apiCall(creds, "/message/custom/send", {
          ...tuituiRouteOf(chatId),
          msgtype: "file",
          file: { fid, filename: file.fileName },
        });
      };
      return {
        async checkCredentials(): Promise<MessagingAccountInfo | null> {
          // The credential's whole job is this socket, so the probe is the handshake itself:
          // no message is sent and nothing is minted. The HTTP API shares the same app id and
          // secret, so a handshake that opens is a credential set that works everywhere.
          await probeHandshake(creds);
          return null;
        },
        sendText: (chatId, text, opts) => sendChunks(chatId, text, opts),
        // The platform has no reply-to field on an outbound message: a reply is a message in
        // the same conversation, which is exactly what `sendText` does. The anchor the bridge
        // holds is still used to find the conversation (see tuituiReplyTargetOf).
        replyText: (messageId, text, opts) =>
          sendChunks(tuituiReplyTargetOf(messageId), text, opts),
        sendImage: (chatId, file) => sendFile(chatId, "image", file),
        sendFile: (chatId, file) => sendFile(chatId, "file", file),
        async fetchImage(url: string, maxBytes: number): Promise<MessagingInboundImageData> {
          const data = await downloadCapped(url, maxBytes, "The image");
          // The bytes decide the type when they are conclusive: the platform's own content
          // type is whatever the sender's upload claimed, and a data URL built from an
          // unhelpful `application/octet-stream` is one no provider accepts.
          return { data, mimeType: sniffImageMime(data) ?? "image/png" };
        },
        fetchFile: (url, maxBytes) => downloadCapped(url, maxBytes, "The file"),
        async react(chatId, messageId, emoji): Promise<void> {
          const native = messageId.slice(messageId.indexOf(REPLY_SEPARATOR) + 1);
          if (native === "" || emoji === "") return;
          const base = { msgtype: "emoji_reaction", emoji_reaction: { emoji, cancel: false } };
          await apiCall(creds, "/message/custom/modify", {
            ...base,
            ...(chatId.startsWith("teams_")
              ? (() => {
                  const [, teamId = "", channelId = "", ...rest] = chatId.split("_");
                  return {
                    toteams: [
                      {
                        team_id: teamId,
                        channel_id: channelId,
                        parent_id: rest.join("_"),
                        post_id: native,
                      },
                    ],
                  };
                })()
              : /^\d{16}$/.test(chatId)
                ? { togroups: [{ group: chatId, msgid: native }] }
                : { tousers: [{ user: chatId, msgid: native }] }),
          });
        },
      };
    },

    async connect(creds: TuituiCredentials, handlers: TuituiHandlers): Promise<TuituiConnection> {
      if (creds.appId === "" || creds.appSecret === "") {
        throw new Error("malformed tuitui binding config (appId/appSecret)");
      }
      return new TuituiSession(creds, handlers, {
        createSocket,
        retryMs,
        handshakeTimeoutMs,
        pingIntervalMs,
      });
    },
  };

  /** Opens a socket, waits for the handshake, closes — the credential probe. */
  async function probeHandshake(creds: TuituiCredentials): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = createSocket(tuituiSocketUrl(creds));
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // A socket that already failed has nothing to close.
        }
        if (err === undefined) resolve();
        else reject(err);
      };
      const timer = setTimeout(
        () => finish(new Error("Tuitui handshake timed out")),
        handshakeTimeoutMs,
      );
      timer.unref?.();
      socket.addEventListener("open", () => finish());
      socket.addEventListener("error", () =>
        finish(new Error("Tuitui rejected these credentials")),
      );
      socket.addEventListener("close", (evt) =>
        finish(new Error(`Tuitui closed the connection during the handshake (code ${evt.code})`)),
      );
    });
  }
}

interface SessionOpts {
  createSocket: (url: string) => TuituiSocket;
  retryMs: (failures: number) => number;
  handshakeTimeoutMs: number;
  pingIntervalMs: number;
}

/**
 * One live event stream: the socket, its acknowledgements, its deduplication and its
 * reconnect loop.
 *
 * Acknowledgement happens before deduplication and before parsing, because an unacknowledged
 * frame is one the platform will send again — including one this process cannot read. A frame
 * with no `event_id` is dropped without an ack: there is nothing to acknowledge it with, and
 * the platform redelivering it is indistinguishable from a fresh event.
 *
 * Deduplication is in memory, bounded, and deliberately kept across reconnects: a frame the
 * platform never got an acknowledgement for is redelivered after one, so a set cleared on
 * `open` would answer exactly those replays twice. It dies with the process, which is the one
 * redelivery it cannot cover (the bridge keeps its own watermark for the rest).
 */
class TuituiSession implements TuituiConnection {
  private socket: TuituiSocket | null = null;
  private closed = false;
  private failures = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();

  constructor(
    private readonly creds: TuituiCredentials,
    private readonly handlers: TuituiHandlers,
    private readonly opts: SessionOpts,
  ) {
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Closing an already-dead socket is not a failure.
    }
  }

  private open(): void {
    if (this.closed) return;
    let socket: TuituiSocket;
    try {
      socket = this.opts.createSocket(tuituiSocketUrl(this.creds));
    } catch (err) {
      this.fail(err);
      return;
    }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      // The handshake deadline is reported through the socket's own close path: closing it
      // here would race the platform's 401, and one failure must not be counted twice.
      try {
        socket.close();
      } catch {
        // nothing to close
      }
      this.fail(new Error("Tuitui handshake timed out"));
    }, this.opts.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();

    socket.addEventListener("open", () => {
      if (this.closed || this.socket !== socket) return;
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.failures = 0;
      this.startPing(socket);
      this.handlers.onReady?.();
    });
    socket.addEventListener("message", (evt) => {
      if (this.closed || this.socket !== socket) return;
      this.onFrame(evt.data);
    });
    socket.addEventListener("error", () => {
      // A socket error is followed by a close; the recovery belongs to one path, not two.
    });
    socket.addEventListener("close", (evt) => {
      if (this.closed || this.socket !== socket) return;
      this.fail(new Error(`Tuitui connection closed (code ${evt.code})`));
    });
  }

  /** Every frame that carries an id is acknowledged, then read at most once. */
  private onFrame(raw: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!isRecord(frame)) return;
    const eventId = stringField(frame, "event_id");
    if (eventId === undefined) return;
    try {
      this.socket?.send(JSON.stringify({ ack: eventId }));
    } catch {
      // An ack that cannot be sent is the socket's problem; the redelivery it causes is
      // handled by the seen-set below.
    }
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    if (this.seen.size > SEEN_EVENT_LIMIT) {
      // The platform redelivers promptly or not at all, so the oldest ids are the ones that
      // can be forgotten; a Set keeps insertion order, which is exactly that order.
      const keep = [...this.seen].slice(-SEEN_EVENT_KEEP);
      this.seen.clear();
      for (const id of keep) this.seen.add(id);
    }
    const evt = normalizeTuituiEvent(frame);
    if (evt !== null) void this.handlers.onMessage(evt);
  }

  private startPing(socket: TuituiSocket): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    // The server keeps the application-level keepalive; this is the transport's own liveness
    // check, and it is what notices a socket that went away without a close frame.
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) return;
      try {
        // A socket without the `ws` ping extension simply rides on the platform's keepalive.
        socket.ping?.();
      } catch {
        this.fail(new Error("Tuitui ping failed"));
      }
    }, this.opts.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  /**
   * One failure, one report, then a retry with the next backoff step.
   *
   * The delay steps are the reference bridge's own sequence (2s, 5s, 10s, 30s, 60s, then
   * 60s forever) so a platform outage is retried at a rate the platform already sees from
   * that bridge. Recovery resets the step, so a flapping connection does not climb to the
   * minute-long delay and stay there.
   */
  private fail(err: unknown): void {
    if (this.closed) return;
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // nothing to close
    }
    this.failures += 1;
    this.handlers.onError?.(err);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, this.opts.retryMs(this.failures));
    this.retryTimer.unref?.();
  }
}
