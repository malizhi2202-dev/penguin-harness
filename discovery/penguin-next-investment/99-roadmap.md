# 99 · 第 1 轮汇总与建议改动清单

- 日期：2026-09-17
- 主议题：`penguin-next-investment`
- 已过审核门的子议题：`context-cache-economics`（见同目录，`05-review-record.md` 为唯一评审证据）

## 一、第 1 轮已定结论（子议题 1）

| 方向 | 内容 | 依据 |
|---|---|---|
| **A** | 请求前缀指纹审计：发请求前记录 `sha256(rendered prefix)` + 长度 + 影响缓存的参数（thinking level / 模型引用 / 工具集），随 Trace 落盘 | 事实 3、4、5、6、7 + 侦察推论 3、4 |
| **B** | 指标诚实性与成本口径：拆分"冷启动 0%"与"热会话整段丢 0%"；命中率旁给出重复处理的 input tokens 与折算成本 | 事实 1、2、3 + OpenAI 官方"命中率下降仍可能更省" |

**待确认项（开工前精读一次）**：`@prismshadow/agenthub@0.4.11` 是否已发送缓存亲和键、是否暴露可传参的扩展点（事实 7）。

## 一之二、第 1 轮已定结论（子议题 2：`third-party-skill-ecosystem`）

| 方向 | 内容 | 依据 |
|---|---|---|
| **B1** | 用产品自带 `skill-porting` 把 archify 装到**临时数据根**的 `agent_state/skills/archify/`：钉 commit `72c750bb`、压平 frontmatter、禁用联网检查、逐文件通读；再用 exec 工具出图 + `/preview` 验收 | S1–S6 + 侦察对照结论 |
| **B2** | 验收通过后落长期数据根（**数据不动代码**），并在 skill 目录写 `SOURCE.md` 记录来源/commit/许可 | S2 |
| **B3**（暂缓） | 产品侧治理：第三方技能准入清单 + 来源版本展示；**不 vendor 进核心** | S4 + 否决记录 |

**否决**：vendor 进 `plugins/archify/`、自研同类渲染器、只装 DSH 会话侧、archify 常驻子 agent。

## 一之三、第 1 轮已定结论（子议题 3：`runtime-residency`）

| 方向 | 内容 | 依据 |
|---|---|---|
| **C1** | runbook（`~/.penguin/`，不进仓库）+ 端口转发固定化 + `server-7364.sh status` 探活 | R4 |
| **C2a** | 优先：DSH 侧启动钩子拉起 7364（不动产品仓库；**DSH 是否提供待确认**） | 未验证 |
| **C2b** | 退路：`.vscode/tasks.json` 一个 `runOn: folderOpen` 的幂等任务（唯一可能的仓库改动，可回退） | R3 + 已抓 VS Code 文档 |
| **C3** | 可选加固：容器内 watchdog + cron 探活（只解进程崩） | R1、R2 |

**否决**：改绑 `0.0.0.0`/直连容器 IP、只靠 crond `@reboot`、指望容器内进程活过容器重启、为自启引入 devcontainer。

## 二、最终《建议改动清单》（**本流程不执行任何代码改动**）

按"先取证、后改动"排序，每条给出所属子议题与依据。

| # | 位置 | 改什么 | 为什么 |
|---|---|---|---|
| # | 动作 | 落点 | 子议题/依据 | 风险 |
|---|---|---|---|---|
| 1 | 升级 `@prismshadow/agenthub` 到 `^0.4.15` + 重建产物 | `packages/core/package.json` | 第 2 轮 D1（U6/U7：请求形状修复影响 wire 前缀） | 中（需验证不回归） |
| 2 | 产品侧"可见部分指纹"（messages/系统提示哈希）落 Trace | 本仓库 Trace 写入侧 | 第 2 轮 D2 + 子议题 1 A（事实 3/4/5 的定案手段） | 低 |
| 3 | 聚合口径：标记"冷启动 0%"与"热会话整段丢 0%" | `packages/server/src/db/repos/usage.ts:190` 附近 | 子议题 1 B | 低 |
| 4 | 呈现：命中率旁给重复 tokens/成本口径，两类 0% 分开展示 | `packages/web/src/features/chat/chat-page.tsx:1657` + `strings.ts`/`strings-en.ts` | 子议题 1 B（事实 1；两本字典都要改） | 低 |
| 5 | （待网关确认）在 agenthub 加 `prompt_cache_key` 或暴露请求选项透传口 | **agenthub 仓库** | 第 2 轮 D3（U1/U3） | 需外部确认 |
| 6 | 自启：`runOn: folderOpen` 幂等任务（C2b）；或 DSH 侧钩子（C2a，待确认） | `.vscode/tasks.json`（唯一可能的仓库改动） | 子议题 3 C2（R2/R3） | 低，可回退 |
| 7 | 常驻：runbook + 端口转发固定化（C1） | `~/.penguin/`（不进仓库） | 子议题 3 C1（R4） | 无 |
| 8 | （待实测）把 archify 装到临时数据根验证 | 数据根 `agent_state/skills/` | 第 1 轮 B1（S1–S6） | 低 |

**执行顺序建议**：1→2（先取证）→ 3→4（口径与呈现）→ 8（数据侧验证，独立）→ 6→7（运维）→ 5（外部确认后）。
**任何执行前**：在 **7466 + 临时数据根**验证，再替换 7364。

## 三、子议题状态

| slug | 状态 | 证据/依据 |
|---|---|---|
| `context-cache-economics` | ✅ 已过审核门（2026-09-17） | 本目录 `01`–`05` |
| `third-party-skill-ecosystem` | ✅ 已过审核门（2026-09-17） | 该目录 `01`–`05`；事实 S1–S6（见下） |
| `runtime-residency` | ✅ 已过审核门（2026-09-17） | 该目录 `01`–`05`；事实 R1–R4（见下） |
| `upstream-client-change-surface` | ✅ 已过审核门（2026-09-17，第 2 轮） | 该目录 `01`–`05`；事实 U1–U7（见第五节） |

### 第 2 轮已定结论（`upstream-client-change-surface`）

| 方向 | 内容 | 依据 |
|---|---|---|
| **D1** | 精读本地 agenthub 0.4.11 的 OpenAI 系客户端，并升级到 `^0.4.15` 后重测命中率 | U6、U7、U2、U5 |
| **D2** | 产品侧"可见部分指纹"（messages/系统提示哈希）落 Trace，不动上游 | U1 + 子议题 1 A |
| **D3**（待确认） | 在 agenthub 加 `prompt_cache_key` 或暴露请求选项透传口 | U1、U3；前置：网关支持度 |

**否决**：fork/vendor agenthub、一上来就改上游加键、把缓存策略写进产品核心、无关地切协议对照。

### 子议题 2 的事实依据（S1–S6，均为只读取得）

| # | 事实 | 依据 |
|---|---|---|
| S1 | 产品自带 `skill-porting` 技能，明确声明"Penguin has no plugin mechanism and needs none：生态里的插件就是 `SKILL.md` + 支持文件的目录，正是 Penguin 安装的形状" | `plugins/skill-porting/skills/skill-porting/SKILL.md` |
| S2 | 安装目标布局：`<app_data_dir>/agents/<agent_id>/agent_state/skills/<skill_name>/`（`SKILL.md` 必需，`icon.svg` 与支持文件可选；**目录名即身份**；frontmatter 自动进系统提示，无注册步骤） | 同上 |
| S3 | 产品的 frontmatter 解析器**只认单行 `key: value`**；YAML 列表、块标量（`>-`/`|`）、嵌套 map 都不解析 | 同上 |
| S4 | 产品的插件库形态：`plugins/<name>/{plugin.json, package.json, icon.svg, skills/<skill>/SKILL.md}`，共 13 个内置插件 | `plugins/*/plugin.json` |
| S5 | 产品 agent **能执行命令**（`createExecCommandTool` / `EXEC_COMMAND_NAME`），并有 MCP provider —— archify 这类 Node CLI 有执行位 | `packages/core/src/environment/tools/exec-command.ts`、`packages/core/src/environment/mcp/provider.ts` |
| S6 | archify 本体（外部）：Node.js 渲染+校验系统，以 Agent Skill 分发，产出**自包含 HTML/SVG**；MIT；要求 Node `^22.19.0 \|\| >=24`（本机 24.21.0）；零依赖 CLI `bin/archify.mjs`（doctor/demo/guide/validate/preview/deliver/compare）；带一个**可关闭的联网更新检查**（`ARCHIFY_UPDATE_CHECK_DISABLED=1`） | <https://github.com/tt-a1i/archify> 的 README（已抓取）；`git ls-remote` 得 HEAD `72c750bb` |

### 子议题 3 的事实依据（R1–R4）

| # | 事实 | 依据 |
|---|---|---|
| R1 | 容器重启会杀死容器内**所有**进程，包括用 `setsid nohup` 脱离 DSH 启动的 7364（PID 3250336 → 重启后需重新拉起） | 本会话运维记录 |
| R2 | 容器内无 init/systemd（`systemctl --user` 报 offline）、无 supervisord/s6/tini；`cron` 已安装但 crond 未运行 | 容器内探查 |
| R3 | 仓库内无 `.devcontainer/`，`.vscode/` 也无 folder-open 任务 | 仓库探查 |
| R4 | 7364 与 3080 均绑定 loopback，依赖 VS Code Remote 端口转发暴露；`~/.vscode-server/data/logs/*/remoteagent.log` 存在 "Failed to connect tunnel to localhost:7364" 的瞬时错误 | 日志 |

## 五、第 2 轮拆解依据（`upstream-client-change-surface`）

第 1 轮收尾时重新扫描事实，拆出下一层子议题：**缓存相关改动的落点与可行性**。依据：

| # | 事实 | 依据 |
|---|---|---|
| U1 | `@prismshadow/agenthub` 是**同组织自有仓库**（`github.com/Prism-Shadow/agenthub`）→ 可改，但在另一个仓库与发布流程里 | `npm view @prismshadow/agenthub` |
| U2 | 产品 `packages/core/package.json` 依赖 `^0.4.11`；本地实际安装 **0.4.11**；npm 最新 **0.4.15**（2026-09-14）→ 升级在允许范围内且是一个候选动作 | `packages/core/package.json`、`packages/cli/node_modules/@prismshadow/agenthub`、npm registry |
| U3 | 其 bundle 内出现缓存相关标识，此前未精读确认是"发键"还是"读用量" | 事实 7 |
| U4 | 发布节奏密（0.4.13→0.4.15 两天内）→ 上游改动能较快到达 | npm registry `time` |
| U5 | agenthub 的 prompt caching **只对 Claude 实现**（0.2.0「prompt caching for Claude」、0.3.1「automatic Claude caching」）；**OpenAI 系客户端无缓存字段相关工作** → 与"本仓库无亲和字段"一致 | agenthub `CHANGELOG.md`（已抓取） |
| U6 | **0.4.12–0.4.15 全是请求形状/协议修复**（工具结果形状、reasoning 字段回放、0.4.15 保留交错并行工具调用的每次函数调用、避免孤儿 `function_call_output`）——而**请求形状直接决定 wire 前缀** → 与缓存命中强相关 | agenthub `CHANGELOG.md` 0.4.12/0.4.13/0.4.14/0.4.15 条目 |
| U7 | 本产品用法落在 Responses/Chat 协议族（`packages/server/src/services/protocol-detect.ts`）→ 0.4.15 的修复正是针对 `openai_responses`/`gpt6` 等客户端 | 同上 + 本仓库探查 |

**不作为子议题的观察项**：模型间命中率差异（`luna` 43% / `terra` 75% / `sol` 67% / `astra` 86%）→ 并入子议题 1 的方向 A（审计按模型切片）。

## 四、循环终止与下一步

- 第 1 轮：3 个子议题全部过门（`context-cache-economics`、`third-party-skill-ecosystem`、`runtime-residency`）。
- 第 2 轮：1 个子议题过门（`upstream-client-change-surface`）。
- **终止判断**：第 2 轮结束时重扫事实，剩余待办均为"执行动作"或"外部信息确认"，**拆不出有事实依据的新一层子议题 → 循环停止**（不进入第 3 轮，不硬凑）。
- **下一步由用户决定**：把《建议改动清单》交给下游技能（如 `bmad-build`）或直接执行；任何执行按既有规矩在 **7466 + 临时数据根**先验证，再替换 7364。
