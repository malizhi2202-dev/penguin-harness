# ② 竞品与其他产品做法 · third-party-skill-ecosystem

- 技能：`bmad-deep-recon`（competitive + technical）
- 联网方式：本会话 `web_search` 不可用 → 直接抓一手来源；未抓到的明确标注「未联网验证」

## 一手来源（已抓取）

### archify 的分发矩阵（README，<https://github.com/tt-a1i/archify>）

| 宿主 | 安装方式 |
|---|---|
| Claude Code | `~/.claude/skills/`（`npx skills add tt-a1i/archify -g`） |
| 通用 agent skill | `~/.agents/skills/` |
| opencode | `~/.config/opencode/skills/` |
| Raven | `~/.raven/workspace/skills` |
| Claude.ai | 上传 zip |
| **DeepSeek Harness** | `dsh plugin --profile web add @tt-a1i/archify-dsh@0.1.0`（社区适配） |

README 明确：**"No repository is required"**（可仅凭描述生成图）；无 Node 环境时走 prompt-driven fallback。技术形态：agent 产出 typed JSON IR → 确定性编译为自包含 HTML/SVG；零依赖 CLI（doctor/demo/guide/validate/preview/deliver/compare）；MIT；要求 Node `^22.19.0 || >=24`；存在一个**可关闭**的联网更新检查（`ARCHIFY_UPDATE_CHECK_DISABLED=1`）。

### DSH 插件生态（`find_dsh_plugin` 检索）

- `tt-a1i/archify`（脚本检索显示 ★65333）、中文移植 `GongYuanCaiJi/dsh-archify`（★8）；安装即执行，第三方代码需 review + 钉 commit。

## 产品自身事实（S1–S6，只读）

| # | 事实 | 依据 |
|---|---|---|
| S1 | "Penguin has no plugin mechanism and needs none：生态插件就是 `SKILL.md` + 支持文件的目录，正是 Penguin 安装的形状" | `plugins/skill-porting/skills/skill-porting/SKILL.md` |
| S2 | 安装布局 `<app_data_dir>/agents/<agent_id>/agent_state/skills/<skill_name>/`；目录名即身份；frontmatter 自动进系统提示，无注册步骤 | 同上 |
| S3 | frontmatter 只认单行 `key: value`；YAML 列表、块标量、嵌套 map 不解析 | 同上 |
| S4 | 插件库形态 `plugins/<name>/{plugin.json, package.json, icon.svg, skills/<skill>/SKILL.md}`，13 个内置插件 | `plugins/*/plugin.json` |
| S5 | 产品 agent 能执行命令（`createExecCommandTool` / `EXEC_COMMAND_NAME`），并有 MCP provider | `packages/core/src/environment/tools/exec-command.ts`、`.../mcp/provider.ts` |
| S6 | archify 本体：见上文一手来源 | 已抓 README；HEAD = `72c750bb070d95171dbb2244e5b62b1b7da69c12`（`git ls-remote`） |

## 对照结论（有依据）

1. 生态（Claude Code / DSH / opencode / Raven）与产品的技能形态**同构**：都是"目录 + frontmatter + 按需读取正文"（S1 原话 + archify 分发矩阵）。
2. 因此接入成本只剩两点：**脚本能否执行**（S5 ✓，产品有 exec 工具）与**产物能否看到**（产品有 `/preview/*`）。
3. 产品比生态多一层现成能力：**自带 `skill-porting` 技能**，把这个流程产品化（S1–S3），不需要新机制（S4 表明"内置插件"是仓库内 vendor 的另一条路，成本更高）。

## 未联网验证（不写入结论）

- Cursor 的 skills 目录约定（未抓文档）。
- 上述星数为脚本检索返回值，未独立核实。
