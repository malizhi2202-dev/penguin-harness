# Tuitui (推推) joins the messaging channels as the fifth one

- **Date:** 2026-09-16
- **Type:** feature
- **Scope:** `server`, `web`, `docs`

[中文版](2026-09-16-messaging-tuitui.zh.md)

Tuitui (推推), 360's enterprise IM, joined Feishu, Telegram, QQ and WeChat as the fifth messaging
channel. A Session bound to a Tuitui robot answers its direct chats, group chats and teams posts,
receives text, images and files, and sends text and files back, through the same binding API and
the same editor the other four channels use.

## Details

- The binding stores an `appId`, an `appSecret` and a `host`. The App ID is the account identity,
  the secret follows the site-wide mask rule and never round-trips, and `host` is the one field
  that is not secret: blank means `im.example.com`, and only a bare host name is accepted — a scheme, a
  path or an explicit port is refused, since the port is the platform's own 8282.
- Every call carries the credential in its query string — `?auth=<appId>.<appSecret>` on the event
  socket and `?appid=…&secret=…` on each HTTP request — because the platform has no token
  exchange: nothing is minted, nothing expires, and every URL the server builds is treated as a
  secret that no error quotes.
- One WebSocket carries every conversation the robot takes part in. A frame with a top-level
  `event_id` is acknowledged with `{"ack": "<event_id>"}` before it is read, and the platform
  redelivers anything unacknowledged, so the acknowledgement and the dedup set answer redelivery
  separately. A dropped socket reconnects after 2, 5, 10, 30 and 60 seconds and then keeps the last
  delay.
- A group message or a teams post reaches the Agent only when it carries the platform's own `at_me`
  flag; a direct chat is never gated.
- An accepted message is marked received with 推推's own「收到」emoji, once per message and before the
  run starts. A refused receipt costs the gesture alone — it is never recorded as a failed delivery —
  and a channel with no such gesture (the other four) is not asked for one.
- Outbound, the platform has no reply-to field, so a reply is a message in the same conversation,
  and a text already sent cannot be edited. An image goes out as the same `msgtype: "file"` an
  attachment does, because the platform has no image message type of its own — a known capability
  downgrade. A teams post is the one conversation shape that renders Markdown — and if the platform
  refuses that render, the same text goes out plainly rather than being lost — while it accepts no
  uploaded attachments.
- Inbound, text, images and files arrive as ordinary input; voice and video are not downloaded as
  media and reach the conversation as a line of text carrying their URL.
- The credential test is the event socket's handshake, which sends nothing and names no account.
  `POST …/messaging/tuitui/test-message` reuses the shared test text and answers 409
  `tuitui_no_chat` until the robot has been messaged once.
- The Web App's binding editor gained this channel's form beside the other four.
