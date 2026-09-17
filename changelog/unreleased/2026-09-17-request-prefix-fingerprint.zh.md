# 每次 Request 都记录它交给模型的前缀

- **Date:** 2026-09-17
- **Type:** feature
- **Scope:** `core`, `docs`

[English](2026-09-17-request-prefix-fingerprint.md)

`request_begin` 现在携带本次 Request 所发前缀的指纹:被指纹记录的 sha256、仅固定头部的另一
个哈希(`session_meta` 加工具清单记录)、覆盖的记录数、序列化长度、本次 Request 是否逐字节
扩展上一次,以及它携带的思考等级。

## 细节

- 该块由 builder 一处盖章,每个字段都是可选的:旧读者看到的仍是原来的 payload,旧 Trace 回放
  不受影响。
- compaction Request 同样盖章,但刻意不成为后续轮次 Request 的基线——失败的回 compaction 会让
  原 context 继续生效,下一轮仍然扩展它之前生效的前缀。
- 只对 payload 取指纹:envelope 的 `timestamp` 从不到达模型,纳入它会在消息被重建时误报"前缀被
  改写"。
- 引擎对"已发出内容"的记账仅在 Request 提交后推进,因此不提交任何内容的重试不会把同一份输入
  计两次。
