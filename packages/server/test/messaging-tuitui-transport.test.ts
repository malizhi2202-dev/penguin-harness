/**
 * The Tuitui production adapter — the half of the channel that talks to 360's platform.
 *
 * messaging-tuitui.test.ts drives the connector and its routes over a fake transport, which
 * leaves everything under that seam unexercised: the envelope reader, the address shapes the
 * three chat kinds need, the credential-in-URL calls, the media upload, and the event
 * socket's whole ack / dedup / reconnect protocol. Those are where a platform failure
 * actually reaches this product, so they get their own file.
 *
 * Nothing here opens a socket or a connection. `globalThis.fetch` is stubbed the way
 * messaging-qq-transport.test.ts stubs it, and the event stream runs on a fake socket passed
 * through `TuituiTransportOpts.createSocket` — a test hook rather than a module mock, because
 * this suite shares one module registry across files and `vi.mock` would leak into every
 * later one (see vitest.config.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import type {
  TuituiCredentials,
  TuituiSocket,
  TuituiTransport,
  TuituiTransportOpts,
} from "../src/runtime/messaging/tuitui-api.js";
import {
  TUITUI_INVALID_CREDENTIALS_CODE,
  TUITUI_MAX_TEXT_CHARS,
  TuituiApiError,
  createTuituiTransport,
  normalizeTuituiEvent,
  splitTuituiText,
  tuituiMessageIdOf,
  tuituiReplyTargetOf,
  tuituiRouteOf,
  tuituiSocketUrl,
} from "../src/runtime/messaging/tuitui-api.js";
import { waitFor } from "./helpers.js";

const CREDS: TuituiCredentials = {
  appId: "tuitui-app-id",
  appSecret: "tuitui-app-secret-ABCD-1234",
  host: "im.example.com",
};

const SEP = "\u0001";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One recorded request against the stubbed fetch. */
interface Call {
  url: string;
  method: string;
  body: string;
}

/** Installs a fetch stub for the run of `body`, and hands it the calls it recorded. */
async function withFetch<T>(
  answer: ((call: Call, index: number) => Response | null) | null,
  body: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const answered = answer === null ? null : answer(call, calls.length - 1);
    return answered ?? jsonResponse({ errcode: 0, data: {} });
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A transport whose fetch resolves through the global at CALL time.
 *
 * `createTuituiTransport` snapshots the fetch it is handed, so a transport built before
 * `withFetch` installs its stub would talk to the real platform. This suite must never do
 * that — it did once, and the platform answered with its rate-limit refusal, which is what
 * this helper exists to prevent.
 */
function transportOf(opts: TuituiTransportOpts = {}): TuituiTransport {
  return createTuituiTransport({
    ...opts,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
}

/** The parsed body of one recorded call (`{}` for the multipart upload, whose body is a FormData). */
function bodyOf(call: Call): Record<string, unknown> {
  return call.body === "" ? {} : (JSON.parse(call.body) as Record<string, unknown>);
}

/**
 * A socket the test drives by hand.
 *
 * The seam's `addEventListener` shape is implemented with real overloads so the fake is
 * handed in without a cast — the point of the seam is that a test socket and a real one are
 * the same kind of object.
 */
class FakeSocket implements TuituiSocket {
  readonly sent: string[] = [];
  pings = 0;
  closed = false;
  /** Every URL the transport asked for, in order. */
  static readonly opened: FakeSocket[] = [];

  private readonly listeners = new Map<string, ((evt: never) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  // The seam's own four signatures, so the fake is assignable to TuituiSocket rather than
  // cast into it: a fake whose listener shape has drifted should not compile.
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (evt: { data: unknown }) => void): void;
  addEventListener(type: "error", fn: () => void): void;
  addEventListener(type: "close", fn: (evt: { code: number }) => void): void;
  addEventListener(type: string, fn: (evt: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  ping(): void {
    this.pings += 1;
  }

  send(data: string): void {
    if (this.closed) throw new Error("socket already closed");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers one frame (a string, exactly as the platform sends it). */
  deliver(frame: unknown): void {
    this.emit("message", { data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  emitOpen(): void {
    this.emit("open", {});
  }

  emitClose(code = 1006): void {
    this.emit("close", { code });
  }

  private emit(type: string, evt: { data?: unknown; code?: number }): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as (e: unknown) => void)(evt);
  }

  /** The JSON frames this socket was asked to send. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  acks(): unknown[] {
    return this.frames()
      .filter((frame) => "ack" in frame)
      .map((frame) => frame.ack);
  }
}

/** One event frame in the platform's envelope. */
function frame(event: string, data: Record<string, unknown>, eventId = "evt-1"): unknown {
  return {
    event_id: eventId,
    body: { event, data, user_account: "alice", user_name: "Alice" },
  };
}

afterEach(() => {
  FakeSocket.opened.length = 0;
});

describe("the Tuitui envelope reader", () => {
  it("keys a direct chat by the peer's account", () => {
    const evt = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-1", msg_type: "text", text: "hello" }, "evt-a"),
    );
    expect(evt).not.toBeNull();
    expect(evt?.chatId).toBe("alice");
    expect(evt?.chatKind).toBe("direct");
    expect(evt?.addressed).toBe(true);
    expect(evt?.nativeMessageId).toBe("m-1");
    expect(evt?.text).toBe("hello");
    expect(evt?.senderName).toBe("Alice");
    expect(evt?.imageUrls).toEqual([]);
    expect(evt?.files).toEqual([]);
  });

  it("carries the platform's own at_me flag on a group message", () => {
    const plain = normalizeTuituiEvent(
      frame("group_chat", {
        group_id: 1234567890123456,
        msgid: "m-2",
        msg_type: "text",
        text: "hi",
      }),
    );
    expect(plain?.chatId).toBe("1234567890123456");
    expect(plain?.chatKind).toBe("group");
    expect(plain?.addressed).toBe(false);

    const mentioned = normalizeTuituiEvent(
      frame("group_chat", { group_id: "1234567890123456", msgid: "m-3", at_me: true }),
    );
    expect(mentioned?.addressed).toBe(true);

    // The platform has shipped `1` where the documentation says boolean.
    const numeric = normalizeTuituiEvent(
      frame("group_chat", { group_id: "1234567890123456", msgid: "m-3", at_me: 1 }),
    );
    expect(numeric?.addressed).toBe(true);
  });

  it("mints a channel post's chat id from its three parts, threading on parent_id", () => {
    const thread = normalizeTuituiEvent(
      frame("teams_post_create", {
        team_id: "t-1",
        channel_id: "c-2",
        post_id: "p-9",
        parent_id: "p-1",
        content: "in a thread",
      }),
    );
    expect(thread?.chatId).toBe("teams_t-1_c-2_p-1");
    expect(thread?.nativeMessageId).toBe("p-9");
    // A channel post's text is its own `content` field; there is no `msg_type` here.
    expect(thread?.text).toBe("in a thread");
    expect(thread?.chatKind).toBe("group");

    // `parent_id: "0"` is the platform's way of saying the post has no parent.
    const root = normalizeTuituiEvent(
      frame("teams_post_modify", {
        team_id: "t-1",
        channel_id: "c-2",
        post_id: "p-9",
        parent_id: "0",
        content: "top level",
      }),
    );
    expect(root?.chatId).toBe("teams_t-1_c-2_p-9");

    // An absent parent_id is the same thing as "0".
    const absent = normalizeTuituiEvent(
      frame("teams_post_create", { team_id: "t-1", channel_id: "c-2", post_id: "p-9" }),
    );
    expect(absent?.chatId).toBe("teams_t-1_c-2_p-9");
  });

  it("renders each non-text message type into the text the model reads", () => {
    const image = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-4",
        msg_type: "image",
        images: ["https://cdn.example.com/a.png", { url: "https://cdn.example.com/b.png" }],
      }),
    );
    expect(image?.text).toBe(
      "[图片] https://cdn.example.com/a.png\n[图片] https://cdn.example.com/b.png",
    );
    expect(image?.imageUrls).toEqual([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png",
    ]);

    const mixed = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-5",
        msg_type: "mixed",
        text: "look at this",
        images: [{ url: "https://cdn.example.com/c.png" }],
      }),
    );
    expect(mixed?.text).toBe("look at this");
    expect(mixed?.imageUrls).toEqual(["https://cdn.example.com/c.png"]);

    // A mixed message with no caption falls back to the images themselves.
    const captionedless = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-6", msg_type: "mixed", images: ["https://cdn/x.png"] }),
    );
    expect(captionedless?.text).toBe("[图片]");

    const voice = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-7", msg_type: "voice", voice: "https://cdn/v.amr" }),
    );
    expect(voice?.text).toBe("[语音] https://cdn/v.amr");

    const video = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-8", msg_type: "video", video: "https://cdn/v.mp4" }),
    );
    expect(video?.text).toBe("[视频] https://cdn/v.mp4");

    const link = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-9",
        msg_type: "link",
        link: { url: "https://example.com", title: "Example" },
      }),
    );
    expect(link?.text).toBe("[网页链接]\nExample\nhttps://example.com");

    // A message type this adapter has never seen still yields whatever text it carried.
    const unknown = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-10", msg_type: "poll", text: "which one?" }),
    );
    expect(unknown?.text).toBe("which one?");
  });

  it("collects a channel post's attachments, which carry no msg_type at all", () => {
    const evt = normalizeTuituiEvent(
      frame("teams_post_create", {
        team_id: "t-1",
        channel_id: "c-2",
        post_id: "p-1",
        content: "see attached",
        files: [{ url: "https://cdn.example.com/a.pdf", name: "a.pdf" }],
        images: [{ url: "https://cdn.example.com/b.png" }],
      }),
    );
    expect(evt?.files).toEqual([{ url: "https://cdn.example.com/a.pdf", name: "a.pdf" }]);
    expect(evt?.imageUrls).toEqual(["https://cdn.example.com/b.png"]);

    // A name the platform left out is still a file; a URL repeated in both shapes is one file.
    const nameless = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-1",
        msg_type: "file",
        file: { url: "https://cdn.example.com/c.bin" },
        files: [{ url: "https://cdn.example.com/c.bin", name: "c.bin" }],
      }),
    );
    expect(nameless?.files).toEqual([{ url: "https://cdn.example.com/c.bin", name: "c.bin" }]);
  });

  it("collects a file attachment as both text and a downloadable attachment", () => {
    const evt = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-11",
        msg_type: "file",
        file: { url: "https://cdn.example.com/report.pdf", name: "report.pdf" },
      }),
    );
    expect(evt?.text).toBe("[文件] report.pdf : https://cdn.example.com/report.pdf");
    expect(evt?.files).toEqual([{ url: "https://cdn.example.com/report.pdf", name: "report.pdf" }]);
    expect(evt?.imageUrls).toEqual([]);
  });

  it("appends a quoted message to the text, since this platform cannot reply with one", () => {
    const evt = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-12",
        msg_type: "text",
        text: "what does this mean?",
        ref: { msgid: "m-1", user_name: "Bob", content: "the quoted line" },
      }),
    );
    expect(evt?.text).toBe("what does this mean?\n\n[引用来自 Bob 的消息]\nthe quoted line");

    // A quote with no text of its own is still a message.
    const only = normalizeTuituiEvent(
      frame("single_chat", {
        msgid: "m-13",
        msg_type: "text",
        ref: { msgid: "m-1", user_name: "Bob", content: "the quoted line" },
      }),
    );
    expect(only?.text).toBe("[引用来自 Bob 的消息]\nthe quoted line");
  });

  it("survives the reference client's null `ref` and drops frames with nothing to answer", () => {
    // The Python bridge writes `ref: null` into its own JSON, and this reader must not care.
    const withNullRef = normalizeTuituiEvent(
      frame("single_chat", { msgid: "m-6", msg_type: "text", text: "quoted", ref: null }),
    );
    expect(withNullRef?.text).toContain("quoted");

    expect(normalizeTuituiEvent(frame("keepalive", {}, "evt-keep"))).toBeNull();
    expect(normalizeTuituiEvent(frame("something_new", { msgid: "m-7" }))).toBeNull();
    expect(normalizeTuituiEvent({ event_id: "evt-8" })).toBeNull();
    expect(normalizeTuituiEvent("not a frame")).toBeNull();
  });
});

describe("the Tuitui address shapes", () => {
  it("picks the audience from the chat id's own shape", () => {
    expect(tuituiRouteOf("alice")).toEqual({ tousers: ["alice"] });
    expect(tuituiRouteOf("1234567890123456")).toEqual({ togroups: ["1234567890123456"] });
    expect(tuituiRouteOf("teams_t-1_c-2_p-1")).toEqual({
      toteams: [{ team_id: "t-1", channel_id: "c-2", parent_id: "p-1" }],
    });
    // A channel id may contain digits: the prefix decides before the 16-digit test does.
    expect(tuituiRouteOf("teams_1234567890123456_c-2_")).toEqual({
      toteams: [{ team_id: "1234567890123456", channel_id: "c-2", parent_id: "" }],
    });
    // Seventeen digits is not the group shape.
    expect(tuituiRouteOf("12345678901234567")).toEqual({ tousers: ["12345678901234567"] });
  });

  it("packs the conversation into the seam's message id and reads it back", () => {
    const packed = tuituiMessageIdOf("1234567890123456", "m-9");
    expect(packed).toBe(`1234567890123456${SEP}m-9`);
    expect(tuituiReplyTargetOf(packed)).toBe("1234567890123456");
    // An id the platform never minted (no native id at all) still names its conversation.
    expect(tuituiReplyTargetOf(tuituiMessageIdOf("alice", ""))).toBe("alice");
    expect(tuituiReplyTargetOf("unpacked")).toBe("unpacked");
  });

  it("splits long text at paragraph breaks, then lines, then the ceiling", () => {
    const paragraphs = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
    expect(splitTuituiText(paragraphs, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);

    const lines = `${"c".repeat(20)}\n${"d".repeat(20)}`;
    expect(splitTuituiText(lines, 30)).toEqual(["c".repeat(20), "d".repeat(20)]);

    // A single unbroken run is cut at the ceiling itself, with nothing lost.
    const run = "e".repeat(75);
    const parts = splitTuituiText(run, 40);
    expect(parts.map((part) => part.length)).toEqual([40, 35]);
    expect(parts.join("")).toBe(run);

    // Whitespace is still one part: the blank-answer guard lives in the send path, which
    // this splitter is never reached from (see the "sends nothing at all" case above).
    expect(splitTuituiText("  ", TUITUI_MAX_TEXT_CHARS)).toEqual(["  "]);
  });
});

describe("the Tuitui HTTP client", () => {
  it("sends plain text to a direct chat, with the credentials in the URL and no reply field", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.sendText("alice", "hello there");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        `https://${CREDS.host}:8282/robot/message/custom/send?appid=${CREDS.appId}&secret=${CREDS.appSecret}`,
      );
      expect(calls[0]?.method).toBe("POST");
      expect(bodyOf(calls[0]!)).toEqual({
        tousers: ["alice"],
        msgtype: "text",
        text: { content: "hello there" },
      });
    });
  });

  it("addresses a group by its id and a channel post by its three parts", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.sendText("1234567890123456", "to the group");
      await client.sendText("teams_t-1_c-2_p-1", "to the channel");
      expect(bodyOf(calls[0]!).togroups).toEqual(["1234567890123456"]);
      expect(bodyOf(calls[1]!).toteams).toEqual([
        { team_id: "t-1", channel_id: "c-2", parent_id: "p-1" },
      ]);
    });
  });

  it("replies into the conversation packed into the message id, since the platform has no quote", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.replyText(tuituiMessageIdOf("alice", "m-1"), "an answer");
      expect(bodyOf(calls[0]!)).toEqual({
        tousers: ["alice"],
        msgtype: "text",
        text: { content: "an answer" },
      });
      // Nothing in the payload names the message being answered: there is nowhere to put it.
      expect(JSON.stringify(bodyOf(calls[0]!))).not.toContain("m-1");
    });
  });

  it("renders Markdown only where the platform can, and falls back to plain text elsewhere", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.sendText("teams_t-1_c-2_p-1", "# Title", { markdown: true });
      expect(bodyOf(calls[0]!)).toEqual({
        toteams: [{ team_id: "t-1", channel_id: "c-2", parent_id: "p-1" }],
        msgtype: "richtext/markdown",
        richtext: { markdown: "# Title" },
      });

      // A group and a direct chat take plain text: the same call without the flag.
      await client.sendText("1234567890123456", "# Title", { markdown: true });
      expect(bodyOf(calls[1]!).msgtype).toBe("text");
    });
  });

  it("resends the same text plainly when the platform refuses the Markdown form", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    let refused = 0;
    await withFetch(
      (call) => {
        const body = bodyOf(call);
        if (body.msgtype === "richtext/markdown") {
          refused += 1;
          return jsonResponse({ errcode: 40002, errmsg: "markdown not allowed here" });
        }
        return null;
      },
      async (calls) => {
        await client.sendText("teams_t-1_c-2_p-1", "# Title\n\nbody", { markdown: true });
        expect(refused).toBe(1);
        // Two calls: the refused render, then the SAME text as a plain message. The seam
        // promises a formatting failure costs formatting, never the reply.
        expect(calls).toHaveLength(2);
        expect(bodyOf(calls[1]!)).toEqual({
          toteams: [{ team_id: "t-1", channel_id: "c-2", parent_id: "p-1" }],
          msgtype: "text",
          text: { content: "# Title\n\nbody" },
        });
      },
    );
  });

  it("reports a plain-text send that fails after a refused render", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(
      () => jsonResponse({ errcode: 40002, errmsg: "no" }),
      async () => {
        // Both attempts fail: the failure the caller sees is the plain one, not a silent pass.
        await expect(
          client.sendText("teams_t-1_c-2_p-1", "hello", { markdown: true }),
        ).rejects.toThrow(/40002/);
      },
    );
  });

  it("splits a long answer into messages at the platform's ceiling, announcing nothing", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    const long = `${"x".repeat(TUITUI_MAX_TEXT_CHARS)}\n\ntail`;
    await withFetch(null, async (calls) => {
      await client.sendText("alice", long);
      expect(calls).toHaveLength(2);
      const first = bodyOf(calls[0]!).text as { content: string };
      const second = bodyOf(calls[1]!).text as { content: string };
      expect(first.content).toHaveLength(TUITUI_MAX_TEXT_CHARS);
      expect(second.content).toBe("tail");
      // No `(1/2)` marker: the bridge's own accounting owns that, not this splitter.
      expect(first.content).not.toContain("(1/2)");
    });
  });

  it("sends an empty or blank answer as nothing at all", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.sendText("alice", "   ");
      expect(calls).toHaveLength(0);
    });
  });

  it("uploads an attachment and names the returned media id as the message's fid", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(
      (call) =>
        call.url.includes("/media/upload")
          ? jsonResponse({ errcode: 0, data: { media_id: "media-7" } })
          : null,
      async (calls) => {
        await client.sendFile("alice", {
          fileName: "report.pdf",
          data: Buffer.from("bytes"),
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url).toContain("/robot/media/upload?");
        expect(calls[1]?.url).toContain("/robot/message/custom/send?");
        expect(bodyOf(calls[1]!)).toEqual({
          tousers: ["alice"],
          msgtype: "file",
          file: { fid: "media-7", filename: "report.pdf" },
        });
      },
    );
  });

  it("sends an image as a file, which is the only shape this platform has for it", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(
      (call) =>
        call.url.includes("/media/upload")
          ? jsonResponse({ errcode: 0, data: { media_id: "media-8" } })
          : null,
      async (calls) => {
        await client.sendImage("alice", {
          fileName: "chart.png",
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        });
        // The upload is typed as an image; the message type is still `file`.
        expect(calls[0]?.url).toContain("/media/upload");
        expect(bodyOf(calls[1]!).msgtype).toBe("file");
      },
    );
  });

  it("refuses to attach anything to a channel post", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await expect(
        client.sendFile("teams_t-1_c-2_p-1", { fileName: "x.txt", data: Buffer.from("x") }),
      ).rejects.toThrow(/no uploaded attachments/);
      expect(calls).toHaveLength(0);
    });
  });

  it("reacts to a direct message and to a channel post in the platform's own shapes", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(null, async (calls) => {
      await client.react("alice", tuituiMessageIdOf("alice", "m-1"), "👀");
      expect(calls[0]?.url).toContain("/robot/message/custom/modify?");
      expect(bodyOf(calls[0]!)).toEqual({
        tousers: [{ user: "alice", msgid: "m-1" }],
        msgtype: "emoji_reaction",
        emoji_reaction: { emoji: "👀", cancel: false },
      });

      await client.react("teams_t-1_c-2_p-1", tuituiMessageIdOf("teams_t-1_c-2_p-1", "p-9"), "👀");
      expect(bodyOf(calls[1]!)).toEqual({
        toteams: [{ team_id: "t-1", channel_id: "c-2", parent_id: "p-1", post_id: "p-9" }],
        msgtype: "emoji_reaction",
        emoji_reaction: { emoji: "👀", cancel: false },
      });

      // Nothing to react to: the platform identifies a message by its own id, not by the
      // conversation, and a frame that carried none gets no call.
      await client.react("alice", tuituiMessageIdOf("alice", ""), "👀");
      await client.react("alice", tuituiMessageIdOf("alice", "m-1"), "");
      expect(calls).toHaveLength(2);
    });
  });

  it("reports the platform's own error code, and never the credential-bearing URL", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(
      () => jsonResponse({ errcode: TUITUI_INVALID_CREDENTIALS_CODE, errmsg: "appid 不合法" }, 200),
      async () => {
        const err = await client.sendText("alice", "hello").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TuituiApiError);
        expect((err as TuituiApiError).errcode).toBe(TUITUI_INVALID_CREDENTIALS_CODE);
        expect((err as TuituiApiError).errmsg).toBe("appid 不合法");
        expect((err as Error).message).not.toContain(CREDS.appSecret);
      },
    );
  });

  it("reports an HTTP refusal without quoting the credential-bearing URL", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    await withFetch(
      () => new Response("nope", { status: 502 }),
      async () => {
        const err = await client.sendText("alice", "hello").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("HTTP 502");
        expect((err as Error).message).not.toContain(CREDS.appSecret);
        expect((err as Error).message).not.toContain("appid=");
      },
    );
  });

  it("downloads an inbound attachment under the bridge's cap", async () => {
    const transport = transportOf();
    const client = transport.createClient(CREDS);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch;
    try {
      const file = await client.fetchFile("https://cdn.example.com/report.pdf", 1024);
      expect([...file]).toEqual([1, 2, 3, 4]);

      const tooBig = await client
        .fetchFile("https://cdn.example.com/report.pdf", 2)
        .catch((e: unknown) => e);
      expect(tooBig).toBeInstanceOf(Error);
      expect((tooBig as Error).message).toMatch(/larger than|cap/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("probes the credentials with the event socket's own handshake", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportOf({
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      handshakeTimeoutMs: 50,
    });
    const client = transport.createClient(CREDS);
    const probe = client.checkCredentials();
    await waitFor(() => sockets.length === 1);
    // The credential travels in the URL — that is this platform's whole auth model.
    expect(sockets[0]?.url).toBe(tuituiSocketUrl(CREDS));
    sockets[0]!.emitOpen();
    await expect(probe).resolves.toBeNull();
    expect(sockets[0]?.closed).toBe(true);

    const refused = client.checkCredentials();
    await waitFor(() => sockets.length === 2);
    sockets[1]!.emitClose(1008);
    await expect(refused).rejects.toThrow(/closed the connection during the handshake/);
  });
});

describe("the Tuitui event session", () => {
  /** A transport whose socket is the test's to drive, with a collapsed backoff. */
  function session(
    overrides: {
      retryMs?: number;
      pingIntervalMs?: number;
    } = {},
  ): {
    sockets: FakeSocket[];
    messages: ReturnType<typeof normalizeTuituiEvent>[];
    errors: unknown[];
    ready: () => number;
    connect: () => Promise<{ close(): void }>;
  } {
    const sockets: FakeSocket[] = [];
    const state = {
      sockets,
      messages: [] as ReturnType<typeof normalizeTuituiEvent>[],
      errors: [] as unknown[],
      readyCount: 0,
    };
    const transport = transportOf({
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      retryMs: () => overrides.retryMs ?? 1,
      handshakeTimeoutMs: 1_000,
      pingIntervalMs: overrides.pingIntervalMs ?? 10_000,
    });
    return {
      ...state,
      get messages() {
        return state.messages;
      },
      get errors() {
        return state.errors;
      },
      ready: () => state.readyCount,
      connect: async () =>
        await transport.connect(CREDS, {
          onMessage: (evt) => {
            state.messages.push(evt);
          },
          onReady: () => {
            state.readyCount += 1;
          },
          onError: (err) => {
            state.errors.push(err);
          },
        }),
    };
  }

  it("acknowledges every frame before it decides whether to read it", async () => {
    const s = session();
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    const socket = s.sockets[0]!;
    socket.emitOpen();

    // A keepalive is acknowledged — the platform is waiting for the ack — and dropped.
    socket.deliver(frame("keepalive", {}, "evt-keep"));
    expect(socket.acks()).toEqual(["evt-keep"]);
    expect(s.messages).toHaveLength(0);

    // The same event delivered twice is acknowledged twice and read once.
    const once = frame("single_chat", { msgid: "m-1", msg_type: "text", text: "hi" }, "evt-1");
    socket.deliver(once);
    socket.deliver(once);
    expect(socket.acks()).toEqual(["evt-keep", "evt-1", "evt-1"]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.text).toBe("hi");
  });

  it("reads a frame it cannot parse as nothing, and acknowledges nothing", async () => {
    const s = session();
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    const socket = s.sockets[0]!;
    socket.emitOpen();

    socket.deliver("not json at all");
    socket.deliver({ body: { event: "single_chat", data: {} } });
    expect(socket.sent).toHaveLength(0);
    expect(s.messages).toHaveLength(0);
  });

  it("reconnects after a close, reporting one failure and a second ready", async () => {
    const s = session();
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    s.sockets[0]!.emitOpen();
    expect(s.ready()).toBe(1);

    s.sockets[0]!.emitClose(1006);
    await waitFor(() => s.sockets.length === 2);
    expect(s.errors).toHaveLength(1);
    s.sockets[1]!.emitOpen();
    await waitFor(() => s.ready() === 2);

    // A failure already counted is not counted again by the close that follows it.
    s.sockets[1]!.emitClose(1006);
    await waitFor(() => s.sockets.length === 3);
    expect(s.errors).toHaveLength(2);
  });

  it("remembers what it already read across a reconnect, because an unacked frame comes back", async () => {
    const s = session();
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    s.sockets[0]!.emitOpen();
    const once = frame("single_chat", { msgid: "m-1", msg_type: "text", text: "hi" }, "evt-1");
    s.sockets[0]!.deliver(once);
    expect(s.messages).toHaveLength(1);

    s.sockets[0]!.emitClose(1006);
    await waitFor(() => s.sockets.length === 2);
    s.sockets[1]!.emitOpen();
    // The platform resends what it never saw acknowledged; it is still only read once.
    s.sockets[1]!.deliver(once);
    expect(s.sockets[1]!.acks()).toEqual(["evt-1"]);
    expect(s.messages).toHaveLength(1);
  });

  it("pings the socket on its own timer, which is what notices a silent death", async () => {
    const s = session({ pingIntervalMs: 5 });
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    s.sockets[0]!.emitOpen();
    await waitFor(() => s.sockets[0]!.pings > 0);
    expect(s.sockets[0]!.pings).toBeGreaterThan(0);
  });

  it("gives up for good once the connection is closed", async () => {
    const s = session();
    const connection = await s.connect();
    await waitFor(() => s.sockets.length === 1);
    s.sockets[0]!.emitOpen();
    connection.close();
    s.sockets[0]!.emitClose(1006);
    await settle(20);
    expect(s.sockets).toHaveLength(1);
    expect(s.errors).toHaveLength(0);
  });

  it("fails a handshake that never opens, and retries it", async () => {
    const s = session();
    await s.connect();
    await waitFor(() => s.sockets.length === 1);
    // The socket is never opened: the deadline closes it, which is the reconnect path.
    await waitFor(() => s.sockets.length === 2, 2_000);
    expect(s.errors).toHaveLength(1);
  });

  it("refuses a credential set the platform cannot use", async () => {
    const transport = transportOf();
    await expect(
      transport.connect({ ...CREDS, appSecret: "" }, { onMessage: () => {} }),
    ).rejects.toThrow(/malformed tuitui binding config/);
  });
});
