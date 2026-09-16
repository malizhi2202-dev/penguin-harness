# A messaging binding answers the conversation that spoke first, and no other

- **Date:** 2026-09-16
- **Type:** fix
- **Scope:** `server`, `docs`
- **Breaking:** yes — a bound channel used to answer whichever conversation wrote most recently; it now serves only the first one that ever wrote to it, and messages from every other conversation are ignored

[中文版](2026-09-16-messaging-binding-chat-lock.zh.md)

A binding held a single reply target and moved it to whichever conversation wrote last, so two groups
mentioning the bot at once shared one Session's context and each reply landed in whichever group had
spoken most recently. The conversation is now chosen once — the first one that speaks to the binding
— and every message from anywhere else is ignored.

## Details

- The remembered conversation is the binding row's own `lastChatId`, so the rule needs no new column,
  no API field and no migration, and it survives a restart.
- Checked before the arrival stamp and before any outbound client is built: an ignored message costs
  one row read and touches nothing else this binding remembers.
- Ignored in silence rather than refused, because a conversation that was never invited should not
  learn from the refusal that the robot exists.
- A Telegram forum topic is a conversation of its own, so a binding locks onto the first topic it is
  written in.

## Compatibility

- Nothing to migrate and no data changes. An existing binding keeps working in the conversation its
  `lastChatId` already names — the chat it was created from, or the most recent one it answered — so a
  binding that had drifted to another conversation stays there until it is moved deliberately.
- To move a binding to a different conversation, delete the channel's configuration in the Web App and
  add it again: the next message chooses the conversation, and the previous one is ignored from then
  on.
