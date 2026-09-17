# ① 头脑风暴 · runtime-residency

- 技能：`bmad-brainstorming`（自主模式）｜无 `_bmad/` 脚本 → 无 memlog
- 约束（事实 R1–R4，均已复核）：容器 PID 1 = `bash`（无 init/systemd/supervisor）；`crond` 未运行；无 `.devcontainer/`、`.vscode/` 为空；7364 绑 loopback 靠 VS Code Remote 转发；`~/.penguin/server-7364.sh` 幂等可执行

## 候选方向（12 个）

| # | 方向 | 影响面 | 可行性 |
|---|---|---|---|
| 1 | VS Code 工作区任务 `runOn: folderOpen` 调 `server-7364.sh start` | 高 | 高（一处仓库改动） |
| 2 | `.devcontainer` 的 `postStartCommand` | 高 | 低（非 devcontainer 环境） |
| 3 | 宿主侧容器 `--restart unless-stopped` / entrypoint | 高 | 需容器外权限 |
| 4 | DSH 侧启动钩子拉起 7364（不动产品仓库） | 高 | 待确认 DSH 能力 |
| 5 | crond `@reboot` | 中 | **不成立**（crond 不自启，循环依赖） |
| 6 | 容器内 watchdog（进程崩了自动拉起） | 中 | 高（但不解容器重启） |
| 7 | 转发固定化（PORTS 面板 Forward a Port / 设置 `forwardPorts`） | 中高 | 高（客户端一次性操作） |
| 8 | runbook（一条命令 + 排查顺序） | 中 | 高 |
| 9 | 让产品监听 `0.0.0.0` | 中 | **否决**（破坏 loopback 预览/应用分离） |
| 10 | 直连 `172.17.0.38:7364` | 中 | **否决**（同上，且容器 IP 会变） |
| 11 | DSH schedule/goal 定时探活自愈 | 中 | 中（依赖 DSH 存活） |
| 12 | 组合兜底：自启钩子 + watchdog + runbook | 高 | 高 |

## 收敛 Top 5

1（工作区任务）、4（DSH 侧钩子，优先不动仓库）、8（runbook）、7（转发固定）、12（组合兜底）。
