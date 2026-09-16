/**
 * Tuitui messaging tests — the fifth channel's mirror of messaging.test.ts, and the proof the
 * connector seam survives a platform that pushes EVERY group message.
 *
 * Two halves. The ordinary one repeats what the other channels already pin, because the route
 * wiring is per-channel even where the behaviour is not: secret masking and keep-on-blank, the
 * App ID as the account identity and the enable-time 409 it collides on, the save/enable
 * split, the host field, the channel-agnostic GET, the credential probe.
 *
 * The half that only exists here is the ADDRESSING GATE. Tuitui delivers every message in
 * every group the robot belongs to and marks the ones that mention it with `at_me`; the other
 * platforms hold an unaddressed message back before this product ever sees it. So the
 * connector — not the platform — decides that a group message without `at_me` is not the
 * bridge's business, and these tests are the ones that matter: an unaddressed group message
 * reaching an agent (or worse, being answered) is the failure this channel can produce that
 * no other channel can. No test opens a socket.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantText } from "@prismshadow/penguin-core";
import type { TextPayload } from "@prismshadow/penguin-core";
import type {
  MessagingBindingsResponse,
  TuituiBindingResponse,
  TuituiTestResponse,
} from "../src/api/types.js";
import type { SessionRow } from "../src/db/repos/sessions.js";
import type { RuntimeSession } from "../src/runtime/session-manager.js";
import { MESSAGING_TEST_MESSAGE } from "../src/runtime/messaging/bridge.js";
import type { MessagingInboundMessage } from "../src/runtime/messaging/connector.js";
import type {
  TuituiBotClient,
  TuituiCredentials,
  TuituiHandlers,
  TuituiInboundEvent,
  TuituiTransport,
} from "../src/runtime/messaging/tuitui-api.js";
import { TUITUI_DEFAULT_HOST, createTuituiTransport } from "../src/runtime/messaging/tuitui-api.js";
import { TuituiConnector, tuituiConfigOf } from "../src/runtime/messaging/tuitui-connector.js";
import { apiClient, createTestApp, provisionUser, waitFor } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const SID = "session-2026-08-27-10-00-00-t9000001";
const SID2 = "session-2026-08-27-10-00-01-t9000002";
const BASE = (sid: string) => `/api/sessions/${sid}/messaging/tuitui`;
const APP_ID = "tuitui-app-id";
const APP_SECRET = "tuitui-app-secret-ABCD-1234";
const PEER = "alice";
const GROUP_ID = "1234567890123456";
const SEP = "\u0001";

// ---------------------------------------------------------------------------
// Fake transport: records sends and reactions, and hands each opened session back to the
// test so it can push events. Never constructs a socket or a fetch.
// ---------------------------------------------------------------------------

interface SentText {
  via: "send" | "reply";
  chatId: string;
  messageId: string;
  text: string;
  markdown: boolean;
}

class FakeTuituiClient implements TuituiBotClient {
  readonly texts: SentText[] = [];
  readonly files: { chatId: string; fileName: string; via: "file" | "image" }[] = [];
  readonly reactions: { chatId: string; messageId: string; emoji: string }[] = [];
  readonly imageFetches: { url: string; maxBytes: number }[] = [];
  readonly fileFetches: { url: string; maxBytes: number }[] = [];
  credentialChecks = 0;
  constructor(
    readonly creds: TuituiCredentials,
    private readonly t: FakeTuituiTransport,
  ) {}

  async checkCredentials(): Promise<null> {
    this.credentialChecks += 1;
    if (this.t.failAuth !== null) throw new Error(this.t.failAuth);
    return null;
  }

  async sendText(chatId: string, text: string, opts?: { markdown?: boolean }): Promise<void> {
    if (this.t.failSend !== null) throw new Error(this.t.failSend);
    this.texts.push({
      via: "send",
      chatId,
      messageId: "",
      text,
      markdown: opts?.markdown === true,
    });
  }

  async replyText(messageId: string, text: string, opts?: { markdown?: boolean }): Promise<void> {
    if (this.t.failSend !== null) throw new Error(this.t.failSend);
    this.texts.push({
      via: "reply",
      chatId: messageId.split(SEP)[0] ?? "",
      messageId,
      text,
      markdown: opts?.markdown === true,
    });
  }

  async sendImage(chatId: string, file: { fileName: string }): Promise<void> {
    this.files.push({ chatId, fileName: file.fileName, via: "image" });
  }

  async sendFile(chatId: string, file: { fileName: string }): Promise<void> {
    this.files.push({ chatId, fileName: file.fileName, via: "file" });
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  async fetchImage(url: string, maxBytes: number) {
    this.imageFetches.push({ url, maxBytes });
    return { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };
  }

  async fetchFile(url: string, maxBytes: number): Promise<Buffer> {
    this.fileFetches.push({ url, maxBytes });
    return Buffer.from("file bytes");
  }
}

class FakeTuituiSession {
  closed = false;
  constructor(
    readonly creds: TuituiCredentials,
    private readonly handlers: TuituiHandlers,
  ) {}
  close(): void {
    this.closed = true;
  }
  /** Pushes one inbound event, as the socket's frame reader would. */
  fire(evt: TuituiInboundEvent): Promise<void> {
    return Promise.resolve(this.handlers.onMessage(evt));
  }
}

class FakeTuituiTransport implements TuituiTransport {
  readonly clients: FakeTuituiClient[] = [];
  readonly sessions: FakeTuituiSession[] = [];
  /** Non-null makes the credential probe throw with this message. */
  failAuth: string | null = null;
  /** Non-null makes every send throw with this message. */
  failSend: string | null = null;

  createClient(creds: TuituiCredentials): FakeTuituiClient {
    const client = new FakeTuituiClient(creds, this);
    this.clients.push(client);
    return client;
  }

  async connect(creds: TuituiCredentials, handlers: TuituiHandlers): Promise<FakeTuituiSession> {
    const session = new FakeTuituiSession(creds, handlers);
    this.sessions.push(session);
    handlers.onReady?.();
    return session;
  }

  lastSession(): FakeTuituiSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("no fake tuitui session was opened");
    return session;
  }

  /** Every text across every client, in the order the platform would have seen them. */
  allTexts(): SentText[] {
    return this.clients.flatMap((c) => c.texts);
  }
}

/** One inbound event, as the api layer would have reduced it. */
function inbound(overrides: Partial<TuituiInboundEvent> = {}): TuituiInboundEvent {
  return {
    chatId: PEER,
    chatKind: "direct",
    nativeMessageId: "m-1",
    text: "what is the status?",
    imageUrls: [],
    files: [],
    addressed: true,
    ...overrides,
  };
}

/** Fake Session: records each run's input payloads and replies with a fixed assistant text. */
function echoFakeSession(
  sessionId: string,
  runs: TextPayload[][],
  reply = "Reply text",
): RuntimeSession {
  return {
    sessionId,
    toolPermission: () => "rw",
    generateTitle: async () => ({ title: null, usage: null }),
    compactability: () => "ok" as const,
    steer: () => false,
    skipReconnectWait: () => false,
    async *run(input) {
      runs.push(input.map((m) => m.payload as TextPayload));
      yield assistantText(reply);
    },
    async *compact() {},
  };
}

function sessionRowOf(sessionId: string, projectId: string): SessionRow {
  return {
    sessionId,
    projectId,
    agentId: "default_agent",
    provider: "custom",
    modelId: "m1",
    workspace: "/tmp/w",
    approvalMode: "allow-all",
    title: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------

describe("tuitui config", () => {
  it("narrows a stored config, defaulting the host and rejecting a malformed one", () => {
    expect(tuituiConfigOf({ appId: APP_ID, appSecret: APP_SECRET })).toEqual({
      appId: APP_ID,
      appSecret: APP_SECRET,
      host: TUITUI_DEFAULT_HOST,
    });
    expect(
      tuituiConfigOf({ appId: APP_ID, appSecret: APP_SECRET, host: "im.internal.example" }),
    ).toEqual({ appId: APP_ID, appSecret: APP_SECRET, host: "im.internal.example" });
    expect(() => tuituiConfigOf({ appId: APP_ID })).toThrow(/malformed tuitui binding config/);
    expect(() => tuituiConfigOf({ appId: "", appSecret: APP_SECRET })).toThrow();
  });
});

describe("the tuitui connector over its transport seam", () => {
  it("drops a group message that does not address the robot, and keeps one that does", async () => {
    const fake = new FakeTuituiTransport();
    const seen: MessagingInboundMessage[] = [];
    await new TuituiConnector(fake).connect(
      { appId: APP_ID, appSecret: APP_SECRET },
      { onMessage: (msg) => void seen.push(msg) },
    );

    await fake
      .lastSession()
      .fire(inbound({ chatKind: "group", chatId: GROUP_ID, addressed: false }));
    expect(seen).toHaveLength(0);

    await fake
      .lastSession()
      .fire(inbound({ chatKind: "group", chatId: GROUP_ID, addressed: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      chatId: GROUP_ID,
      chatKind: "group",
      text: "what is the status?",
    });
  });

  it("packs the conversation into the seam's message id, which is what a reply comes back on", async () => {
    const fake = new FakeTuituiTransport();
    const seen: MessagingInboundMessage[] = [];
    await new TuituiConnector(fake).connect(
      { appId: APP_ID, appSecret: APP_SECRET },
      { onMessage: (msg) => void seen.push(msg) },
    );
    await fake.lastSession().fire(inbound({ nativeMessageId: "m-42" }));
    expect(seen[0]?.messageId).toBe(`${PEER}${SEP}m-42`);
  });

  it("hands each attachment over as a lazy download under the bridge's cap", async () => {
    const fake = new FakeTuituiTransport();
    const seen: MessagingInboundMessage[] = [];
    await new TuituiConnector(fake).connect(
      { appId: APP_ID, appSecret: APP_SECRET },
      { onMessage: (msg) => void seen.push(msg) },
    );
    await fake.lastSession().fire(
      inbound({
        text: "look",
        imageUrls: ["https://cdn.example.com/a.png"],
        files: [{ url: "https://cdn.example.com/report.pdf", name: "report.pdf" }],
      }),
    );

    const message = seen[0]!;
    // Nothing was downloaded on arrival: the bridge decides whether it wants the bytes.
    expect(fake.clients[0]?.imageFetches).toHaveLength(0);
    expect(message.images).toHaveLength(1);
    expect(message.files?.[0]?.fileName).toBe("report.pdf");

    const image = await message.images![0]!.fetch(4096);
    expect(image.mimeType).toBe("image/png");
    expect(fake.clients[0]?.imageFetches).toEqual([
      { url: "https://cdn.example.com/a.png", maxBytes: 4096 },
    ]);
    const file = await message.files![0]!.fetch(8192);
    expect(file.toString()).toBe("file bytes");
    expect(fake.clients[0]?.fileFetches).toEqual([
      { url: "https://cdn.example.com/report.pdf", maxBytes: 8192 },
    ]);
  });

  it("forwards the connection's own lifecycle, and refuses a credential set it cannot use", async () => {
    const fake = new FakeTuituiTransport();
    const errors: unknown[] = [];
    let ready = 0;
    await new TuituiConnector(fake).connect(
      { appId: APP_ID, appSecret: APP_SECRET },
      {
        onMessage: () => {},
        onReady: () => void (ready += 1),
        onError: (e) => void errors.push(e),
      },
    );
    expect(ready).toBe(1);
    expect(fake.sessions[0]?.creds).toEqual({
      appId: APP_ID,
      appSecret: APP_SECRET,
      host: TUITUI_DEFAULT_HOST,
    });

    await expect(
      new TuituiConnector(fake).connect({ appSecret: APP_SECRET }, { onMessage: () => {} }),
    ).rejects.toThrow(/malformed tuitui binding config/);
  });
});

describe("tuitui binding routes", () => {
  let t: TestApp;
  let api: ReturnType<typeof apiClient>;
  let fake: FakeTuituiTransport;
  let projectId: string;
  let runs: TextPayload[][];

  /** Save the credentials, then flip the toggle on and wait for the connection. */
  const bindEnabled = async (sid: string, appId = APP_ID, put: Record<string, unknown> = {}) => {
    expect((await api.put(BASE(sid), { appId, appSecret: APP_SECRET, ...put })).status).toBe(200);
    expect((await api.post(`${BASE(sid)}/state`, { enabled: true })).status).toBe(200);
    await waitFor(() => t.deps.messaging.statusOf(sid, "tuitui").state === "connected");
  };

  beforeEach(async () => {
    fake = new FakeTuituiTransport();
    t = await createTestApp({ tuituiTransport: fake });
    const { cookie } = await provisionUser(t.app, "birder");
    api = apiClient(t.app, cookie);
    projectId = "birder-default_project";
    runs = [];
    const row = sessionRowOf(SID, projectId);
    t.deps.sessionsRepo.insert(row);
    t.deps.manager.adopt(row, echoFakeSession(SID, runs));
  });
  afterEach(async () => {
    await t.cleanup();
  });

  // —— Routes ——————————————————————————————————————————————————————————————

  it("PUT saves the pair and the host only (secret masked, App ID as the account, disabled)", async () => {
    const res = await api.put(BASE(SID), { appId: APP_ID, appSecret: APP_SECRET });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuituiBindingResponse;
    expect(body.binding?.channel).toBe("tuitui");
    expect(body.binding?.appId).toBe(APP_ID);
    expect(body.binding?.appSecretMasked).toBe("tuit…1234");
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    expect(body.binding?.enabled).toBe(false);
    expect(body.status.state).toBe("disconnected");
    expect(fake.sessions).toHaveLength(0);
    // The App ID is the account identity, exactly as the Feishu app id is.
    expect(t.deps.messagingRepo.find(SID, "tuitui")?.accountId).toBe(APP_ID);
    // The host is stored (not assumed), and defaults when it is not typed.
    expect(body.binding?.host).toBe(TUITUI_DEFAULT_HOST);
    const custom = (await (
      await api.put(BASE(SID), { appId: APP_ID, host: "im.internal.example" })
    ).json()) as TuituiBindingResponse;
    expect(custom.binding?.host).toBe("im.internal.example");
    expect(t.deps.messagingRepo.find(SID, "tuitui")?.config.appSecret).toBe(APP_SECRET);

    // Blank secret keeps the stored one; still dark.
    expect((await api.put(BASE(SID), { appId: APP_ID })).status).toBe(200);
    expect(t.deps.messagingRepo.find(SID, "tuitui")?.config.appSecret).toBe(APP_SECRET);
    expect(fake.sessions).toHaveLength(0);
  });

  it("refuses a first bind with no secret, and a host that is not a host name", async () => {
    const bare = await api.put(BASE(SID), { appId: APP_ID });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe(
      "tuitui_secret_required",
    );

    for (const host of [
      "https://im.example.com",
      "im.example.com/robot",
      "im.example.com:9000",
      "im live",
    ]) {
      const res = await api.put(BASE(SID), { appId: APP_ID, appSecret: APP_SECRET, host });
      expect(res.status).toBe(400);
    }
    expect(t.deps.messagingRepo.find(SID, "tuitui")).toBeNull();
  });

  it("clears a stored secret only when asked, and never while the connection is on", async () => {
    await bindEnabled(SID);
    const refused = await api.put(BASE(SID), { appId: APP_ID, clearAppSecret: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "messaging_disable_before_clear",
    );

    expect((await api.post(`${BASE(SID)}/state`, { enabled: false })).status).toBe(200);
    const cleared = (await (
      await api.put(BASE(SID), { appId: APP_ID, clearAppSecret: true })
    ).json()) as TuituiBindingResponse;
    expect(cleared.binding?.appSecretMasked).toBeUndefined();
    // The row and its account identity stay: only the secret is gone.
    expect(cleared.binding?.appId).toBe(APP_ID);
    expect(t.deps.messagingRepo.find(SID, "tuitui")?.config.appSecret).toBe("");
  });

  it("POST /state owns the connection, and a re-save while enabled restarts it", async () => {
    expect((await api.post(`${BASE(SID)}/state`, { enabled: true })).status).toBe(404);
    await bindEnabled(SID);
    expect(fake.lastSession().creds).toEqual({
      appId: APP_ID,
      appSecret: APP_SECRET,
      host: TUITUI_DEFAULT_HOST,
    });

    const rotated = "tuitui-app-secret-EFGH-5678";
    expect((await api.put(BASE(SID), { appId: APP_ID, appSecret: rotated })).status).toBe(200);
    expect(fake.sessions[0]?.closed).toBe(true);
    await waitFor(() => t.deps.messaging.statusOf(SID, "tuitui").state === "connected");
    expect(fake.lastSession().creds.appSecret).toBe(rotated);

    const off = await api.post(`${BASE(SID)}/state`, { enabled: false });
    expect(((await off.json()) as TuituiBindingResponse).status.state).toBe("disconnected");
    expect(fake.lastSession().closed).toBe(true);
  });

  it("the account is the App ID: saving never collides, enabling does", async () => {
    t.deps.sessionsRepo.insert(sessionRowOf(SID2, projectId));
    await bindEnabled(SID);
    expect(
      (await api.put(BASE(SID2), { appId: APP_ID, appSecret: "other-secret-9999" })).status,
    ).toBe(200);

    const blocked = await api.post(`${BASE(SID2)}/state`, { enabled: true });
    expect(blocked.status).toBe(409);
    const refusal = (await blocked.json()) as { error: { code: string; message: string } };
    expect(refusal.error.code).toBe("account_enabled_elsewhere");
    expect(refusal.error.message).not.toContain(SID);

    expect((await api.post(`${BASE(SID)}/state`, { enabled: false })).status).toBe(200);
    expect((await api.post(`${BASE(SID2)}/state`, { enabled: true })).status).toBe(200);
    await waitFor(() => t.deps.messaging.statusOf(SID2, "tuitui").state === "connected");
  });

  it("the channel-agnostic GET carries the masked tuitui binding with its status", async () => {
    await bindEnabled(SID);
    const body = (await (
      await api.get(`/api/sessions/${SID}/messaging`)
    ).json()) as MessagingBindingsResponse;
    const entry = body.bindings.find((b) => b.binding?.channel === "tuitui");
    expect(entry?.binding).toMatchObject({
      channel: "tuitui",
      appId: APP_ID,
      appSecretMasked: "tuit…1234",
      host: TUITUI_DEFAULT_HOST,
      enabled: true,
    });
    expect(entry?.status.state).toBe("connected");
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);

    await api.post(`${BASE(SID)}/state`, { enabled: false });
    expect((await api.delete(BASE(SID))).status).toBe(204);
    expect(t.deps.messagingRepo.find(SID, "tuitui")).toBeNull();
  });

  it("marks an ENABLED row with the tuitui indicator on the session list", async () => {
    await bindEnabled(SID);
    const body = (await (
      await api.get(`/api/projects/${projectId}/agents/default_agent/sessions`)
    ).json()) as {
      sessions: { sessionId: string; messagingChannel?: string }[];
    };
    expect(body.sessions.find((s) => s.sessionId === SID)?.messagingChannel).toBe("tuitui");
  });

  // —— The credential probe ————————————————————————————————————————————————

  it("tests a draft credential without saving it, falling back to the stored one", async () => {
    const draft = await api.post(`${BASE(SID)}/test`, {
      appId: APP_ID,
      appSecret: "draft-secret-0000",
      host: "im.internal.example",
    });
    expect(draft.status).toBe(200);
    expect(((await draft.json()) as TuituiTestResponse).ok).toBe(true);
    expect(fake.clients[0]?.creds).toEqual({
      appId: APP_ID,
      appSecret: "draft-secret-0000",
      host: "im.internal.example",
    });
    // Nothing was saved by probing.
    expect(t.deps.messagingRepo.find(SID, "tuitui")).toBeNull();

    // No stored binding and no draft is a 400, not a probe against blanks: the app id is
    // checked first, and the secret has its own code once an app id is in hand.
    const noAppId = await api.post(`${BASE(SID)}/test`, {});
    expect(noAppId.status).toBe(400);
    expect(((await noAppId.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    const noSecret = await api.post(`${BASE(SID)}/test`, { appId: APP_ID });
    expect(noSecret.status).toBe(400);
    expect(((await noSecret.json()) as { error: { code: string } }).error.code).toBe(
      "tuitui_secret_required",
    );
  });

  it("reports a rejected credential as ok:false rather than an HTTP error", async () => {
    await api.put(BASE(SID), { appId: APP_ID, appSecret: APP_SECRET });
    fake.failAuth = "Tuitui rejected these credentials";
    const res = await api.post(`${BASE(SID)}/test`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuituiTestResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toContain("rejected");
  });

  // —— Inbound ————————————————————————————————————————————————————————————

  it("starts a Task from an inbound direct message and answers into the same conversation", async () => {
    await bindEnabled(SID);
    await fake.lastSession().fire(inbound({ nativeMessageId: "m-1", text: "what is the status?" }));
    await waitFor(() => runs.length === 1);
    // No marker block and no special sender: the model does not learn where this came from.
    expect(runs[0]!.map((p) => p.text)).toEqual(["what is the status?"]);
    await waitFor(() => fake.allTexts().length === 1);
    const sent = fake.allTexts()[0]!;
    // A direct chat needs no thread: the bridge answers with a plain send into the peer's
    // conversation (the same text would reach them either way, and this channel has no quote
    // to carry on a reply). Threading is what a group needs, which is the next test.
    expect(sent.via).toBe("send");
    expect(sent.chatId).toBe(PEER);
    expect(sent.text).toBe("Reply text");
  });

  it("answers an addressed group message in the group, and ignores an unaddressed one entirely", async () => {
    await bindEnabled(SID);
    await fake
      .lastSession()
      .fire(
        inbound({ chatKind: "group", chatId: GROUP_ID, addressed: false, nativeMessageId: "m-2" }),
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(0);
    expect(fake.allTexts()).toHaveLength(0);

    await fake
      .lastSession()
      .fire(
        inbound({ chatKind: "group", chatId: GROUP_ID, addressed: true, nativeMessageId: "m-3" }),
      );
    await waitFor(() => runs.length === 1);
    await waitFor(() => fake.allTexts().length === 1);
    expect(fake.allTexts()[0]).toMatchObject({
      chatId: GROUP_ID,
      messageId: `${GROUP_ID}${SEP}m-3`,
    });
  });

  it("answers a channel post in the post's own thread", async () => {
    await bindEnabled(SID);
    const chatId = `teams_t-1_c-2_p-1`;
    await fake
      .lastSession()
      .fire(inbound({ chatKind: "group", chatId, addressed: true, nativeMessageId: "p-9" }));
    await waitFor(() => fake.allTexts().length === 1);
    expect(fake.allTexts()[0]?.chatId).toBe(chatId);
    expect(fake.allTexts()[0]?.messageId).toBe(`${chatId}${SEP}p-9`);
  });

  it("sends the bridge's own test message once a chat is known, and refuses before that", async () => {
    await bindEnabled(SID);
    const early = await api.post(`${BASE(SID)}/test-message`, {});
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe("tuitui_no_chat");

    await fake.lastSession().fire(inbound({ nativeMessageId: "m-6" }));
    await waitFor(() => runs.length === 1);
    const res = await api.post(`${BASE(SID)}/test-message`, {});
    expect(res.status).toBe(200);
    await waitFor(() => fake.allTexts().length === 2);
    expect(fake.allTexts()[1]?.text).toBe(MESSAGING_TEST_MESSAGE);
    expect(fake.allTexts()[1]?.chatId).toBe(PEER);
  });

  it("survives a platform that goes down mid-answer, without losing the run", async () => {
    await bindEnabled(SID);
    fake.failSend = "Tuitui connection closed (code 1006)";
    await fake.lastSession().fire(inbound({ nativeMessageId: "m-5" }));
    await waitFor(() => runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.allTexts()).toHaveLength(0);
    // The binding is still the enabled one: a failed send is not a failed binding.
    expect(t.deps.messagingRepo.find(SID, "tuitui")?.enabled).toBe(true);
  });

  it("a redelivered message is a complete no-op (the platform repeats an event on purpose)", async () => {
    await bindEnabled(SID);
    await fake.lastSession().fire(inbound({ nativeMessageId: "m-dup" }));
    await waitFor(() => runs.length === 1);
    await fake.lastSession().fire(inbound({ nativeMessageId: "m-dup" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(1);
  });
});

describe("the tuitui adapter's default transport", () => {
  it("builds a real transport without touching the network", () => {
    // The default `createSocket` and fetch are only reached on connect, which this never
    // does: what this pins is that the production wiring constructs at all.
    const transport = createTuituiTransport();
    expect(typeof transport.connect).toBe("function");
    expect(typeof transport.createClient).toBe("function");
  });
});
