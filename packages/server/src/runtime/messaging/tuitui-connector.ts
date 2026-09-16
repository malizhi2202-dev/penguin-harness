/**
 * Tuitui (推推) messaging connector — the fifth implementation of the
 * MessagingChannelConnector seam (see connector.ts), after Feishu, Telegram, QQ and WeChat.
 * It owns everything Tuitui-specific: the config document's shape, and the reduction of the
 * platform's event envelope to the bridge's normalized inbound shape.
 *
 * The wire protocol itself lives in tuitui-api.ts, behind an injectable transport, for the
 * same reason the Feishu SDK and the QQ gateway do: a unit test substitutes a fake socket and
 * a fake fetch and never touches the network.
 *
 * Three things about this channel shape the code here:
 *
 * - **An outbound text cannot quote.** The platform has no reply-to field, so the reply anchor
 *   the bridge holds is the CONVERSATION plus the platform's message id (tuituiMessageIdOf),
 *   and `replyText` sends into that conversation. Nothing is lost: a Tuitui reply would have
 *   landed there anyway.
 * - **A group conversation is not private by delivery.** Tuitui pushes every message of every
 *   group the robot is in, where the other four platforms deliver only what addresses the bot.
 *   Answering all of it would be answering a conversation that never invited the robot, so a
 *   group message that does not carry the platform's own `at_me` flag is dropped here. A direct
 *   chat is always a message to the robot and is never gated.
 * - **A channel (teams) post is a different address shape.** Its chat id is minted by
 *   tuitui-api.ts out of the team, the channel and the thread; this file only carries it.
 */
import type {
  MessagingChannelConnector,
  MessagingClient,
  MessagingConnection,
  MessagingConnectorHandlers,
  MessagingInboundFile,
  MessagingInboundImage,
} from "./connector.js";
import {
  tuituiMessageIdOf,
  type TuituiBotClient,
  type TuituiCredentials,
  type TuituiTransport,
} from "./tuitui-api.js";

/** The Tuitui binding's stored config document (`messaging_bindings.config_json`). */
export interface TuituiBindingConfig extends Record<string, unknown> {
  appId: string;
  appSecret: string;
  host: string;
}

/**
 * Narrows a stored config document; throws a readable error on a malformed one.
 *
 * All three fields are required: this channel is reachable at whatever host its own
 * deployment publishes, so the binding carries it and there is nothing to fall back to.
 */
export function tuituiConfigOf(config: Record<string, unknown>): TuituiBindingConfig {
  const { appId, appSecret, host } = config;
  if (
    typeof appId !== "string" ||
    appId === "" ||
    typeof appSecret !== "string" ||
    appSecret === "" ||
    typeof host !== "string" ||
    host === ""
  ) {
    throw new Error("malformed tuitui binding config (appId/appSecret/host)");
  }
  return { appId, appSecret, host };
}

export class TuituiConnector implements MessagingChannelConnector {
  readonly channel = "tuitui" as const;

  constructor(private readonly transport: TuituiTransport) {}

  private credsOf(config: Record<string, unknown>): TuituiCredentials {
    return tuituiConfigOf(config);
  }

  async createClient(config: Record<string, unknown>): Promise<MessagingClient> {
    // The transport's client already satisfies the seam (checkCredentials, both text sends,
    // both media sends). The react() it adds on top is this channel's own extra and has no
    // caller yet: a receipt gesture belongs to the shared bridge, which is channel-neutral and
    // knows nothing about emoji reactions.
    return this.transport.createClient(this.credsOf(config));
  }

  async connect(
    config: Record<string, unknown>,
    handlers: MessagingConnectorHandlers,
  ): Promise<MessagingConnection> {
    const creds = this.credsOf(config);
    // One client per connection, shared by every inbound attachment's lazy download. Built
    // eagerly because it holds no connection of its own — it is four closures over the
    // credentials — and the alternative would rebuild it per image.
    const client: TuituiBotClient = this.transport.createClient(creds);
    return this.transport.connect(creds, {
      onMessage: (evt) => {
        // The gate above (see the file header): a group message that does not address this
        // robot is not the bridge's business. It is dropped rather than answered with a
        // notice, because a notice per unaddressed group message is exactly the noise the
        // gate exists to prevent.
        if (evt.chatKind === "group" && !evt.addressed) return;
        const images: MessagingInboundImage[] = evt.imageUrls.map((url) => ({
          fetch: (maxBytes) => client.fetchImage(url, maxBytes),
        }));
        const files: MessagingInboundFile[] = evt.files.map((file) => ({
          fileName: file.name,
          fetch: (maxBytes) => client.fetchFile(file.url, maxBytes),
        }));
        return handlers.onMessage({
          chatId: evt.chatId,
          chatKind: evt.chatKind,
          messageId: tuituiMessageIdOf(evt.chatId, evt.nativeMessageId),
          text: evt.text,
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(evt.senderName !== undefined ? { senderName: evt.senderName } : {}),
        });
      },
      ...(handlers.onReady ? { onReady: handlers.onReady } : {}),
      ...(handlers.onError ? { onError: handlers.onError } : {}),
    });
  }
}
