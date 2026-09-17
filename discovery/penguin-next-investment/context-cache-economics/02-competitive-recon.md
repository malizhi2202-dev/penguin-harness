# ② 竞品与其他产品做法 · context-cache-economics

- 技能：`bmad-deep-recon`（competitive + technical）
- **联网方式说明**：本会话 `web_search` 不可用（端点未配置），改为直接抓取官方文档 = 一手来源；未抓到的部分明确标注「未联网验证」。

## 一手来源（已抓取）

### OpenAI · Prompt caching
<https://developers.openai.com/api/docs/guides/prompt-caching>

- 复用要求**整个 rendered prefix 匹配**；"若在某个 breakpoint 之前内容或相关设置变了，该变更之后的 prefix 无法匹配既有缓存条目"。
- 改请求不必然丢弃既有缓存；关键是"后续请求有相同前缀且能命中一个 **eligible matching breakpoint**"。
- 官方提供 **Prompt Caching Dashboard** 与 **Prompt Cache Diagnostics** 用于监控命中率、诊断未命中。
- 官方原话（直接影响本议题口径）：compaction 前后，**"fewer input tokens can still save money even when the cache-hit rate falls"**。
- 缓存有生命周期与保留设置；缓存输入仍计入速率限制。

### DeepSeek · Context Caching
<https://api-docs.deepseek.com/guides/kv_cache>

- 命中要求后续请求**完全匹配一个 cache prefix unit**；不完整匹配 = 不命中。
- unit 的持久化位置：**请求边界**（用户输入末尾、模型输出末尾）、**公共前缀检测**、**固定 token 间隔**（长输入/长输出时，避免长前缀因永不到达结束位置而完全不可缓存）。
- 不再使用后自动清除，"通常几小时到几天"。

## 交叉推论（对本案数据的解释力）

1. 观测到的 **0% 与 ~100% 双峰**，与 DeepSeek"必须完整匹配一个 unit"的语义一致；`cache_read` 全为 256 的倍数与"固定间隔持久化"一致。
2. 观测到的"命中时 `read` 比上一轮 input 略小"（-984/-1862/-4261/-6054）与"unit 边界 + 块粒度"一致，属正常。
3. 观测到的"读到的快照比上一轮旧"（08:10:23 读到 180736，而 08:06:46/08:09:12 各写了 186k）指向**上游侧**：那两次写入未被后续请求命中 —— 可能是多后端/多 key 各自独立的缓存，或条目未被保留为 unit。
4. 产品文档（事实 5）声明了"前缀在一个 Trace 文件内字节固定"的**设计意图**；事实 3/4 显示该意图在真实数据里不足以解释 54% 的整段未命中 → 需要事实 1 的指纹审计来区分"产品违约"与"上游行为"。

## 未联网验证（不写入结论）

- Claude Code / Cursor 的具体缓存保持策略（无搜索能力）。
- `@prismshadow/agenthub` 是否已发送某个亲和键（属代码精读，不属侦察；见结论的"待确认项"）。
