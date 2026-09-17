# ① 头脑风暴 · third-party-skill-ecosystem

- 技能：`bmad-brainstorming`（自主模式）｜无 `_bmad/` 脚本 → 无 memlog
- 约束（事实 S1–S6）：S1 产品自述"不需要插件机制，生态插件就是 SKILL.md + 支持文件的目录"；S2 安装布局在 agent_state/skills/；S3 frontmatter 只认单行；S4 插件库形态；S5 有 exec 命令工具 + MCP；S6 archify = Node CLI + 自包含 HTML 产物、MIT、需 Node ≥22.19/≥24、有可关联网检查

## 候选方向（14 个）

| # | 方向 | 影响面 | 可行性 |
|---|---|---|---|
| 1 | 按 `skill-porting` 流程装进 `agent_state/skills/archify/`（钉 commit） | 高 | 高 |
| 2 | 先用它给产品自己出一张架构图（零风险自用验证） | 中 | 高 |
| 3 | 产物接 `/preview/*` 展示，形成"生成→看图"闭环 | 中高 | 高 |
| 4 | 第三方技能准入清单（许可/联网行为/脚本可读性/Node 版本） | 中 | 高 |
| 5 | 技能来源与版本可追溯（skill 目录内记 commit） | 中 | 高 |
| 6 | 装成仓库内置插件 `plugins/archify/`（vendor 进仓库） | 中 | 中 |
| 7 | 数据根放用户级技能目录（跨 agent 共享） | 中 | 中 |
| 8 | 技能列表 UI 显示来源/版本/许可 | 中 | 中 |
| 9 | 用产品的命令策略管住 skill 脚本的执行与审批 | 中 | 中 |
| 10 | 只在本 DSH 会话侧安装（不进入产品） | 低 | 高 |
| 11 | 参照 archify 的 IR/schema 自研产品原生图 | 中 | 低 |
| 12 | 给 `skill-porting` 加外部来源白名单/镜像 | 低 | 中 |
| 13 | 让 archify 常驻为"架构图"专用子 agent | 低 | 低 |
| 14 | 明确弃用：把 archify 逻辑 vendor 进核心代码 | — | — |

## 收敛 Top 5

1（装进 agent_state）、2（自用出图验证）、3（preview 闭环）、4（准入清单）、5（来源可追溯）。
