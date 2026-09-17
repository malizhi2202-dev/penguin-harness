# ① 头脑风暴 · upstream-client-change-surface

- 技能：`bmad-brainstorming`（自主模式）｜无 `_bmad/` 脚本 → 无 memlog
- 约束（事实 U1–U7）：U1 上游自有仓库可改；U2 产品锁 `^0.4.11`、本地实装 0.4.11、最新 0.4.15；U3 bundle 内缓存标识未精读；U4 上游发版快；**U5 agenthub 的 prompt caching 只给 Claude 做**；**U6 0.4.12–0.4.15 全是请求形状/协议修复**；**U7 产品走 Responses/Chat 协议族，而本地跑的是没有这些修复的 0.4.11**

## 候选方向（8 个）

| # | 方向 | 影响面 | 可行性 |
|---|---|---|---|
| 1 | 精读 agenthub 0.4.11 的 OpenAI 系客户端（`gpt6`/`openai-chat`/`openai_responses`）：是否发亲和键、有无缓存选项 | 高 | 高（零风险只读） |
| 2 | **升级到 0.4.15** 并重测命中率（请求形状修复最可能直接改善前缀稳定） | 高 | 高（semver 已允许） |
| 3 | 在 agenthub 加 `prompt_cache_key` | 中高 | 中（需网关支持） |
| 4 | agenthub 暴露"请求选项透传口"，由产品侧决定 | 中 | 中（需上游配合） |
| 5 | 产品侧只做**可见部分指纹**（messages/系统提示哈希），不动上游 | 高 | 高 |
| 6 | 只读上游返回的用量并按模型切片 | 中 | 高 |
| 7 | 切换协议（`openai-chat` ↔ `openai-responses`）对照观察缓存差异 | 中 | 中 |
| 8 | fork / vendor agenthub 到产品仓库 | 中 | **否决**（分叉维护成本） |

## 收敛 Top 5

1（精读）、2（升级+重测）、5（可见部分指纹）、3（上游加键）、4（透传口）。
