# 为模型、Agent 模板与默认插件集引入公共配置作用域

- **Date:** 2026-09-11
- **Type:** feat
- **Scope:** `core`, `server`, `web`, `docs`

[English](2026-09-11-common-config-scope.md)

每个数据根目录现在都可以有一个**公共配置作用域** `<root>/common/`：配置一次，供所有 Project 取用——它的模型表、它的 Agent 模板，以及新建 Agent 时自动装上的插件集。三样东西各有各的规则：模型与模板是**拷贝**过来的，默认插件集只在创建 Agent 的人什么都没选时生效；而当某个 Project 从它那里复制过一次之后，两者就再无关联。

## 细节

- **模型是拷贝。** 新建 Project 时把公共模型表整份复制过去（凭证一并复制，所以新 Project 一出现就可用；公共侧没有配置模型时仍从内置预设起步）。公共侧后来新增的模型，用模型页的「从公共配置导入」（`POST /api/projects/:p/models/import-common`，仅 owner）收进已有 Project。导入只追加：Project 已有的同名 `(provider, model_id)` 条目保留自己的凭证与元信息，`default_model` 与 `vision_model` 只在 Project 原本没有时才采纳，`addedCount` 如实报告实际落下的条数。公共侧一条模型都没有时返回 409 `no_common_models`，而不是一个空成功。
- **作用域开箱带着 General Agent。** 首次读取该作用域的 Agent 列表时，会像创建 Project 一样用同一个内置 `default_agent` 把它初始化出来（含库中预装插件），于是这个作用域一打开就有一个可以直接改的模板，而不是一张空表，Project 的新建对话框也能立刻选到它。该初始化只对保留 id 生效、只在该作用域一个 Agent 都没有时执行，且从不覆盖已有 Agent；它不读取也不复制任何 Project 自己的 General Agent，而从未用到这个作用域的数据根目录依旧不会多出 `common/` 目录。
- **Agent 模板是拷贝。** 带 `templateAgentId` 创建 Agent 时，复制模板的行为——`system_config.yaml`、`AGENTS.md`、`skills/`、`hooks/`、`tools/`——而 `.vault.toml`、`memory/` 与 `schedule/` 留在原地：凭证、那个 Agent 的个人记忆与它的定时工作都不是行为。同一次请求里给的 `name` / `description` 优先；没给则新 Agent 用自己的 id。模板已不存在时返回 404 `agent_not_found`，且在各种写入之前就已判明，不会留下一个做了一半的 Agent。
- **默认插件集在「什么都没选」时生效。** `<root>/common/plugins.toml` 里的 `default_plugins`，会在创建者既没选插件、也没选模板与快照时装到新 Agent 上。显式给空列表表示「不要」，因此选择器可以让人清掉预选的默认值。名字在写文件之前先到内置库核对（400），此后若库里不再有某个名字，会作为 `unknownPlugins` 回报，而不是让编辑器其余部分无法保存。缺文件即「没有默认值」，与从前新建一个空 Agent 的行为一致。
- **这个作用域不是 Project。** 它复用保留 id `common` 与 Project 的目录布局，但永不出现在列表里，也不能被创建、改名或删除，更不能在其中开启 Session。管理员通过常规 Project 路由在其中解析为 owner——这使所有既有的写路由（创建 Agent、配置、技能、钩子）无需第二条规则就是管理员专属——其他人访问 `/api/projects/common/…` 得到的 404 与访问一个无权 Project 完全相同。
- **命令行也能直接寻址。** 保留 id 就是一个普通的 `--project-id` 取值：`penguin config model … --project-id common` 直接改的就是本机数据根目录里的公共模型表。
- **两个读接口对所有已登录用户开放**，因为成员在为自己的 Project 创建 Agent 时需要它们：`GET /api/common/plugins`（默认插件集）与 `GET /api/common/agent-templates`（模板身份与技能、钩子数量——不含配置正文、技能内容或凭证）。
- **没有 `common/` 目录时一切照旧**：内置预设目录、空的默认插件集、空的模板清单，与从前完全一致。
- **Web App**：管理员在**系统设置 → 全局配置**（服务器分组下方的一个分组）里直接打开该作用域的三个界面（插件库 / 模型库 / 智能体，即那三个 Project 页面本身，只是由设置页带着公共配置作用域打开，应用自身的作用域不变）；另有模型页的「从公共配置导入」、创建 Agent 弹窗里的模板选择器与默认插件预选，以及插件库页的「新建 Agent 的默认插件」编辑器。切换器里只列 Project，侧栏也始终显示当前 Project 的导航。该作用域内不提供对话与各类按 Project 统计的页面，模型、Agent 与插件库才是它的用途。
- 已经带着一个占用保留 id 的 Project 的数据根目录，会保留该 Project 照常可用（会话、改名、删除都不受影响），只是作用域在该 Project 让出这个 id 之前不可用；这一决定及其移除条件记录在[本批次的兼容性条目](2026-09-11-backward-compatibility.zh.md)中。
