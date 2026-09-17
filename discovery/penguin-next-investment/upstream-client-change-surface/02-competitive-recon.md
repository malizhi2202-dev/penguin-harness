# ② 竞品与技术侦察 · upstream-client-change-surface

- 技能：`bmad-deep-recon`（technical + competitive）
- 联网方式：`web_search` 不可用 → 直接抓一手来源（npm registry、上游 `CHANGELOG.md`）；未抓到的标注「未联网验证」

## 一手来源（已抓取）

### agenthub `CHANGELOG.md`（<https://github.com/Prism-Shadow/agenthub>）

- **0.2.0**（2026-01-22）：「…with **prompt caching for Claude**」
- **0.3.1**（2026-04-28）：「…and **automatic Claude caching**」
- **0.4.12**（2026-09-11）：OpenAI Chat / Kimi K3 / GLM 的**工具结果形状**修复
- **0.4.13**（2026-09-12）：OpenAI Chat 在无思维链时**仍带 reasoning 字段回放**工具调用轮
- **0.4.14**（2026-09-12）：DeepSeek V4 与 GPT Responses 客户端把纯文本工具结果发成字符串
- **0.4.15**（2026-09-14）：Responses 客户端（`openai_responses`/`gpt6`/`deepseek_v4`/`minimax_m3`）**保留交错并行工具调用的每一次函数调用**，网关"先全开再逐个关闭"时不再只剩最后一次，下一次请求不再因孤儿 `function_call_output` 失败

### npm registry

- `@prismshadow/agenthub` 仓库 `git+https://github.com/Prism-Shadow/agenthub.git`（**同组织自有**）
- 最新 `0.4.15`；`0.4.13 → 0.4.15` 在两天内发布；首版 2026-01-22 起持续迭代

## 核心推论（有依据）

1. **U5**：缓存相关实现只覆盖 Claude（`cache_control` 断点），OpenAI 系协议无缓存字段工作 → 与"本仓库 `packages/*/src` 无亲和字段"（事实 6）互相印证；即 OpenAI 系路径完全依赖 provider 的自动前缀缓存。
2. **U6+U7**：0.4.12–0.4.15 全为**请求形状/协议正确性**修复，而请求形状**直接决定 wire 前缀**；产品本地跑 0.4.11（上述修复之前的版本）。
3. **强线索**：若所连网关"先打开所有工具调用再逐个关闭"，0.4.11 会丢掉除最后一次以外的函数调用 → 下一次请求重放的历史与 provider 已缓存的**前缀不一致** → 整段未命中。方向与观测一致（0%/~100% 双峰、读到的快照比上一轮旧）。

## 未联网验证（不写入结论）

- 所连网关是否支持 `prompt_cache_key`（外部约束）。
- 0.4.15 的修复是否真的改变**本产品**的 wire 前缀（需实测：升级前后对比指纹/命中率）。
- 0.4.15 修复描述的触发条件（"网关先全开再关闭"）是否命中当前网关。
