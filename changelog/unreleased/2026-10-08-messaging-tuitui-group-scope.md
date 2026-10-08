# The Tuitui setup guide gained the platform's group restriction

- **Date:** 2026-10-08
- **Type:** fix
- **Scope:** `web`

[中文版](2026-10-08-messaging-tuitui-group-scope.zh.md)

The binding editor's Tuitui setup steps covered the direct chat and the `@` requirement inside a
group, but said nothing about the platform being able to restrict which groups a robot receives
from — a restricted group pushes nothing at all, so a group chat stayed silent with nothing in the
guide to explain it. The steps now carry that case: where the robot has a group restriction, the
group is set to `*` (all groups).

## Details

- The step was placed with the platform-side setup, where the other channels put their equivalent —
  the QQ sandbox allowlist and Feishu's event subscription.
- Both dictionaries changed together, in the same shape: the Chinese guide and the English one state
  the same step.
