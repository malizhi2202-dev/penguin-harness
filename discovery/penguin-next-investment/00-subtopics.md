# 主议题：penguin-next-investment

PenguinHarness 下一步投入方向（事实文档驱动）。

- 日期：2026-09-17
- 流程：`bmad-discovery-loop`（全程只读，审核通过才落盘）
- 执行偏差：仓库内无 `_bmad/`，bmad 脚本（`resolve_config`/`memlog`/composer）不可用 → ①头脑风暴按**自主模式**在对话内完成、④专家团按默认阵容即兴点名；未写任何 memlog。②的联网部分：本会话 `web_search` 不可用，改为直接抓取官方文档（一手来源）。

## 第 0 步 · 事实清单（唯一拆解依据）

| # | 事实 | 依据 |
|---|---|---|
| 1 | 指标公式 `cacheRead/(cacheRead+cacheWrite)`；文案 `S.chat.statCacheHit` | `packages/web/src/features/chat/chat-page.tsx:1657`；`packages/web/src/lib/strings.ts` |
| 2 | 全库 1912 次带 input 调用：整段未命中 0% 共 601 次（31%）、1–49% 共 95（5%）、50–89% 共 264（14%）、90–99% 共 886（46%）、100% 共 66（3%）；部分命中 359 次 | 数据根 `~/.penguin/data/web.db` 的 `usage_records`（只读） |
| 3 | 会话 `session-2026-09-16-11-56-22-31ba9ce3`：198 次带 input 调用中 108 次整段未命中（54%），整段重算约 1674 万 tokens；输入由 14.6 万单调增长到 20.2 万 | 同上 |
| 4 | 该会话只有 2 个 trace 文件（= 一次 context 轮换），解释不了 108 次整段未命中 | `trace_files` 2 行 |
| 5 | 产品自述不变量：strict 层含请求前缀，**在一个 Trace 文件内字节固定，以便 provider 的 prompt cache 命中**；soft 层 thinking level 一改，代价即 provider 缓存的上下文 | `changelog/unreleased/2026-08-28-context-assembled-per-rotation.md` |
| 6 | 本仓库 `packages/*/src` 内搜不到任何缓存亲和字段（`prompt_cache_key`/`cache_control` 等） | grep（grep 工具，非 shell） |
| 7 | 真正发请求的是外部依赖 `@prismshadow/agenthub@0.4.11`，含 `deepseek_v4`/`gpt6`/`claude5`/`gemini3_8`/`glm5_3`/`kimi_k3`/`ant_messages` 客户端；其 bundle 内出现缓存相关标识，但"发送亲和键"还是"读取用量"**尚未精读确认** | `packages/cli/node_modules/@prismshadow/agenthub/dist/` |
| 8 | 用量记账写入点 | `packages/server/src/db/repos/usage.ts:190` |
| 9 | 用户原话：「这个缓存命中只有47% 查看是否修复下」 | 本会话 |

**缺失声明（不猜）**：网关是否多后端/多 key（本地无任何凭据字段）；用户是否在会话中切过 thinking level（UI 有 picker，Trace 不记录 level）；agenthub 是否已发亲和键（事实 7）。

## 子议题（2–5 个，各带依据）

| slug | 议题 | 依据 | 状态 |
|---|---|---|---|
| `context-cache-economics` | 上下文缓存与 token 经济性 | 事实 1–9 | 第 1 轮 · ①–⑤ 走完并**已过审核门**（2026-09-17） |
| `third-party-skill-ecosystem` | 第三方技能接入（以 archify 为样本） | 事实 S1–S6（见 `99-roadmap.md` 第三节） | 第 1 轮 · ①–⑤ 走完并**已过审核门**（2026-09-17） |
| `runtime-residency` | 服务常驻与自愈（容器重启/端口转发脆弱） | 事实 R1–R4（见 `99-roadmap.md`） | 第 1 轮 · ①–⑤ 走完并**已过审核门**（2026-09-17） |

## 轮次记录

- **第 1 轮**：扫描事实 → 拆出上述 3 个子议题 → `context-cache-economics` 走完 ①头脑风暴 ②竞品侦察 ③结论建议 ④专家团 ⑤审核门，用户以「好的」通过（2026-09-17T17:36+08:00）→ 落盘 → 继续 `third-party-skill-ecosystem`（同日过门）→ 继续 `runtime-residency`（同日过门）。**第 1 轮完成**。
- **第 2 轮**：重新扫描事实（含已通过的结论与待确认项）→ 拆出下一层子议题 `upstream-client-change-surface`（依据 U1–U7）→ 走完 ①–⑤，用户以「好的」通过（2026-09-17）→ 落盘。

### 第 2 轮子议题

| slug | 议题 | 依据 | 状态 |
|---|---|---|---|
| `upstream-client-change-surface` | 缓存相关改动的落点与可行性：上游客户端 `agenthub`（自有仓库） | U1–U7（见 `99-roadmap.md` 第五节） | 第 2 轮 · ①–⑤ 走完并**已过审核门**（2026-09-17） |

**不作为子议题的观察项**（有事实但已并入既有结论，避免硬凑）：模型间命中率差异（`luna` 43% / `terra` 75% / `sol` 67% / `astra` 86%，全库聚合）→ 并入子议题 1 的方向 A（审计需按模型切片）。

## 循环终止判断

**第 2 轮结束时重新执行第 0 步拆解判断**：剩余待办项（升级后重测、网关支持度确认、DSH 是否有启动钩子、archify 实测）**均属"执行动作"或"外部信息确认"，不是可供讨论的新议题**；重扫事实后**拆不出有事实依据的新一层子议题** → **循环到此停止**：不进入第 3 轮、不硬凑子议题。后续由用户决定把这些结论交给哪个下游技能或直接执行（执行须另行批准）。
