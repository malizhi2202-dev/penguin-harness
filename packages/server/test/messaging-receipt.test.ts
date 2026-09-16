/**
 * The receipt seam, channel-neutrally: a channel that can mark an inbound message received is
 * asked exactly once per ACCEPTED message, a channel that cannot is not asked at all, and a
 * refusal costs the gesture and nothing else.
 *
 * Tuitui's own suite proves the chain end to end — which emoji, which conversation, what the
 * platform's wire body looks like. This file proves the contract the shared bridge offers
 * every channel, through a scripted connector: the shape a sixth channel implements, and the
 * one place where "no `react` member at all" (Feishu, Telegram, QQ, WeChat today) is the
 * behavior under test rather than a side effect of another suite. No test opens real network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantText } from "@prismshadow/penguin-core";
import type { OmniMessage } from "@prismshadow/penguin-core";
import type { SessionRow } from "../src/db/repos/sessions.js";
import type { RuntimeSession } from "../src/runtime/session-manager.js";
import { MessagingBridge } from "../src/runtime/messaging/bridge.js";
import type {
  MessagingChannelConnector,
  MessagingClient,
  MessagingInboundMessage,
} from "../src/runtime/messaging/connector.js";
import { toAttachmentLimits } from "../src/services/attachment-limits.js";
import { createTestApp, waitFor } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const SID = "session-2026-09-16-12-00-00-7ec31pt0";

function sessionRowOf(sessionId: string): SessionRow {
  return {
    sessionId,
    projectId: "default_project",
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

describe("a channel that can acknowledge a message", () => {
  let t: TestApp;
  let bridge: MessagingBridge;
  let runs: OmniMessage[][];
  let fired: ((msg: MessagingInboundMessage) => Promise<void>) | null;
  /** Every receipt the bridge asked for, in order. */
  let receipts: { chatId: string; messageId: string }[];
  /** Set by the test that drives a channel whose receipt the platform refuses. */
  let failReceipt: boolean;
  /** False for the scripted channel that has no receipt gesture at all. */
  let supportsReceipt: boolean;

  const scriptedConnector = (): MessagingChannelConnector => ({
    channel: "feishu",
    ...(supportsReceipt ? { receipt: true } : {}),
    createClient: (): Promise<MessagingClient> =>
      Promise.resolve({
        checkCredentials: () => Promise.resolve(null),
        sendText: () => Promise.resolve(),
        replyText: () => Promise.resolve(),
        sendImage: () => Promise.resolve(),
        sendFile: () => Promise.resolve(),
        ...(supportsReceipt
          ? {
              react: (chatId: string, messageId: string) => {
                if (failReceipt) return Promise.reject(new Error("the platform refused it"));
                receipts.push({ chatId, messageId });
                return Promise.resolve();
              },
            }
          : {}),
      }),
    connect: (_config, handlers) => {
      fired = async (msg) => {
        await handlers.onMessage(msg);
      };
      handlers.onReady?.();
      return Promise.resolve({ close: () => {} });
    },
  });

  const fire = (msg: Partial<MessagingInboundMessage> & { messageId: string }) =>
    fired!({ chatId: "oc_scripted", chatKind: "direct", text: null, ...msg });

  const echoSession = (): RuntimeSession => ({
    sessionId: SID,
    toolPermission: () => "rw",
    generateTitle: async () => ({ title: null, usage: null }),
    compactability: () => "ok" as const,
    steer: () => false,
    skipReconnectWait: () => false,
    async *run(input: OmniMessage[]) {
      runs.push(input);
      yield assistantText("Reply text");
    },
    async *compact() {},
  });

  beforeEach(async () => {
    runs = [];
    receipts = [];
    failReceipt = false;
    supportsReceipt = true;
    fired = null;
    t = await createTestApp();
    const row = sessionRowOf(SID);
    t.deps.sessionsRepo.insert(row);
    t.deps.manager.adopt(row, echoSession());
    // The row is stored directly rather than through the route: what this file tests is the
    // bridge's own contract, and going through HTTP would start the App's own bridge on the
    // real Feishu connector first, which is another suite's subject.
    t.deps.messagingRepo.upsert({
      sessionId: SID,
      channel: "feishu",
      accountId: "cli_test_app_0001",
      config: { appId: "cli_test_app_0001", appSecret: "s", baseDomain: "https://open.feishu.cn" },
    });
    t.deps.messagingRepo.setEnabled(SID, "feishu", true);
    t.deps.messaging.stop();
    bridge = new MessagingBridge({
      repo: t.deps.messagingRepo,
      sessions: t.deps.sessionsRepo,
      files: t.deps.workspaceFiles,
      root: t.root,
      attachmentLimits: () => toAttachmentLimits(t.deps.serverSettingsRepo.getAttachmentLimitsMb()),
      channels: t.deps.channels,
      runner: t.deps.manager,
      connectors: [scriptedConnector()],
      errors: t.deps.errors,
      log: () => {},
    });
    await bridge.start();
  });

  afterEach(async () => {
    bridge.stop();
    await t.cleanup();
  });

  it("asks for one receipt per accepted message, before the run", async () => {
    await fire({ messageId: "om_one", text: "status?" });
    await waitFor(() => runs.length === 1);
    await waitFor(() => receipts.length === 1);
    expect(receipts[0]).toEqual({ chatId: "oc_scripted", messageId: "om_one" });
  });

  it("acknowledges a message it cannot run, and one that carries a file", async () => {
    // A receipt says "the robot has this", not "the robot is answering it": a message the
    // bridge answers with its not-supported notice is still a message that arrived, and the
    // gesture must not wait for the decision about what to do with it.
    await fire({ messageId: "om_notice" });
    await waitFor(() => receipts.length === 1);
    expect(runs).toHaveLength(0);

    await fire({
      messageId: "om_file",
      text: "see attached",
      files: [{ fileName: "notes.txt", fetch: async () => Buffer.from("hi") }],
    });
    await waitFor(() => receipts.length === 2);
    expect(receipts[1]).toEqual({ chatId: "oc_scripted", messageId: "om_file" });
    await waitFor(() => runs.length === 1);
  });

  it("does not acknowledge a redelivery", async () => {
    await fire({ messageId: "om_dup", text: "hello" });
    await waitFor(() => receipts.length === 1);
    await fire({ messageId: "om_dup", text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(receipts).toHaveLength(1);
  });

  it("carries on when the platform refuses the receipt", async () => {
    failReceipt = true;
    await fire({ messageId: "om_refused", text: "does this still work?" });
    await waitFor(() => runs.length === 1);
    // Nothing is recorded as a delivery failure: the panel's `lastDeliveryError` answers
    // "did my ANSWER get out", and a decorative gesture is not an answer.
    expect(t.deps.messagingRepo.find(SID, "feishu")?.enabled).toBe(true);
    expect(bridge.statusOf(SID, "feishu").lastDeliveryError).toBeUndefined();
    expect(bridge.statusOf(SID, "feishu").lastInboundAt).toBeTruthy();
  });

  it("skips the gesture entirely for a channel that has none", async () => {
    supportsReceipt = false;
    // A fresh connection with the new connector: the client is cached per entry.
    bridge.stop();
    await bridge.start();
    await fire({ messageId: "om_plain", text: "hello" });
    // The run happens and nothing throws — the member being absent IS the channel's answer.
    await waitFor(() => runs.length === 1);
    expect(receipts).toHaveLength(0);
    expect(bridge.statusOf(SID, "feishu").lastDeliveryError).toBeUndefined();
  });
});
