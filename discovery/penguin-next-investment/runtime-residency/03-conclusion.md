# ③ 结论与建议 · runtime-residency

## 结论（推荐 C1 + C2，C3 可选）

- **C1（立刻，零仓库改动）**：runbook（一条命令 + 排查顺序）+ 端口转发固定化（VS Code PORTS 面板一次性操作）+ 用 `~/.penguin/server-7364.sh status` 探活。
- **C2（主方案，二选一）**：
  - **C2a（优先，不动产品仓库）**：DSH 侧启动钩子拉起 7364 —— **待确认 DSH 是否提供该能力**（未验证）。
  - **C2b（退路，一处仓库改动且可回退）**：工作区 `.vscode/tasks.json` 增加一个 `runOn: folderOpen` 的**幂等**任务（调用既有 `server-7364.sh start`）。
- **C3（可选加固）**：容器内 watchdog（只解"进程崩"，不解"容器重启"）+ cron 定时探活。

依据：R1、R2、R3、R4 + 侦察对照表与核心推论。

## 建议（落地路径）

- C1：把 runbook 写进 `~/.penguin/`（**不进仓库**），并在其中记录"先 `status`，再 `start`，再看 PORTS 面板"的顺序。
- C2b：任务体只调用既有幂等脚本，`isBackground: true`，不新写逻辑。
- 根本解仍是宿主侧 restart policy（C2 的上位方案），需要你在容器外执行。

## 待确认项

- DSH 是否提供启动钩子（决定 C2a 是否可行）。
- `runOn: folderOpen` 在工作区任务中的确切语义（决定 C2b 的写法）。

## 否决记录

| 被否方向 | 理由（依据） |
|---|---|
| 让 7364 监听 `0.0.0.0` 或直连容器 IP | 破坏产品 loopback"预览/应用"分离规则（`packages/server/src/app.ts:405-445`），且容器 IP 会变 |
| 只靠 crond `@reboot` | 循环依赖：crond 自身未运行且不自启（R2） |
| 指望容器内进程活过容器重启 | R1 明确不可能 |
| 为自启引入 devcontainer | 改动面远大于收益（当前环境非 devcontainer，R3） |

## 声明

本流程**不执行任何改动**；C2b 是唯一可能触碰仓库的项，且需用户另行批准。
