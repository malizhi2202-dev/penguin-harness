# ③ 结论与建议 · third-party-skill-ecosystem

## 结论（推荐 B1、B2，暂缓 B3）

**B1（先做，零风险）—— 临时数据根验证**
用产品自带的 `skill-porting` 把 archify 装到**临时数据根**的 `agents/<agent_id>/agent_state/skills/archify/`：
- 钉 commit：`72c750bb070d95171dbb2244e5b62b1b7da69c12`（S6）
- 移植时**压平 frontmatter**（S3 硬约束：只认单行 `key: value`）
- **禁用联网更新检查**：`ARCHIFY_UPDATE_CHECK_DISABLED=1`
- 逐文件通读（尤其 `bin/archify.mjs`、schemas）——`skill-porting` 自身的安全规矩（S1）
- 用 exec 工具（S5）跑 `validate` / `deliver` 出一张真图，用 `/preview/*` 打开验收

**B2（验证通过后）—— 落到长期数据根**
装进正式数据根（**数据，不是代码**：不进仓库、不污染要上传的代码），并在 skill 目录内写 `SOURCE.md` 记录来源 URL + commit + 许可（产品无元数据机制，用文件记录，S2）。

**B3（可后置）—— 产品侧治理**
第三方技能准入清单（许可/联网行为/脚本可读性/Node 版本要求）+ 来源与版本展示；**不 vendor 进核心**。

依据：S1–S6 + 侦察对照结论 1–3。

## 否决记录

| 被否方向 | 理由（依据） |
|---|---|
| 立刻 vendor 进 `plugins/archify/`（内置插件） | 需持续跟上游演进、署名与体积成本；S4 表明这是"进仓库"的路，与 B1/B2 相比无额外收益 |
| 自研同类渲染器 | 成本高、与 archify 生态脱节（侦察：生态已同构，S1 说明无需新机制） |
| 只在本 DSH 会话侧安装 | 不产生产品价值（用户诉求是"接入产品"） |
| 让 archify 常驻为专用子 agent | 过度设计：技能是按需读取的正文，无需常驻 |

## 待确认项（开工前）

- archify 的 `bin/archify.mjs` 是否在无网络、无额外依赖下完整可跑（需一次实际执行验证）。
- 其产物 HTML 与产品 `/preview/*` 的打开方式是否直接兼容（需一次实测）。

## 声明

本流程**不执行任何代码改动**；B1 涉及的是**数据根安装 + 实测**，不含源码修改。执行与否由用户另定。
