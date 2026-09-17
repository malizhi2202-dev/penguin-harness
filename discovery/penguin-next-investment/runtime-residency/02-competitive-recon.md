# ② 竞品与其他产品做法 · runtime-residency

- 技能：`bmad-deep-recon`（technical）
- 联网方式：`web_search` 不可用 → 抓一手文档；未抓到的明确标注「未联网验证」

## 一手来源（已抓取）

**VS Code Tasks 文档** <https://code.visualstudio.com/docs/debugtest/tasks>
- 工作区/文件夹级任务配置在 `.vscode/tasks.json`；
- 文档另有 **Global tasks**（用户级任务）一节，可在任意文件夹运行；
- **`runOn: folderOpen` 的确切适用范围（工作区任务 vs 全局任务）**：文档正文未包含该字段说明 → **未联网验证**，列为待确认项。

## 未联网验证（不写入结论）

- Dev Containers 规范的 `postStartCommand` / `postAttachCommand`（知识内，未抓文档）。
- 宿主 Docker 的 `--restart` 策略在本环境的可用性（需容器外权限，无法从容器内验证）。

## 手段对照（依据：R1–R4 + 上述一手来源）

| 手段 | 生效范围 | 本环境可行性 | 依据 |
|---|---|---|---|
| 工作区任务 `runOn: folderOpen` | VS Code 打开该文件夹时 | 可行（需一处仓库改动） | 已抓文档（任务位置） |
| devcontainer `postStartCommand` | 容器启动时 | 不可直接（非 devcontainer，容器由外部启动） | R3 |
| 宿主 restart policy / entrypoint | 容器启动时 | **最根本**，但需容器外权限 | R1 |
| DSH 侧启动钩子 | DSH 启动时 | 待确认 DSH 是否提供 | 未验证 |
| crond `@reboot` | 系统启动 | **不成立**：crond 未运行且不自启 | R2 |
| 容器内 watchdog | 容器运行期内 | 只解进程崩，不解容器重启 | R1 |
| 端口转发固定化 | VS Code 客户端 | 可行（一次性操作） | R4 |

## 核心推论（有依据）

容器内**没有任何进程能活过容器重启**（R1），因此自启点必须落在**容器/工作区生命周期**上，而非容器内某个进程；`crond @reboot` 方案自我循环（R2）。
