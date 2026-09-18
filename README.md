# Pi 通用 subagents 执行器

这是基于原 pi-subagents 运行时代码裁剪、独立维护的实现。保留 MIT 许可及历史提交，不常规合并或同步上游；只按需评估具体修复。提供通用 `subagent` 工具及 `/subagents` 界面。调用规则由工具描述和参数说明提供，不附带重复的用法 skill；任务方法与业务标准由调用方按需提供。

## 安装与更新

将本仓库作为本地包加入 Pi `settings.json`，不要使用 `git:` 包源：

```json
{
  "packages": ["C:/path/to/pi-subagents"]
}
```

本地路径直接加载源码，不受 `pi update --extensions` 的 Git 包同步管理。修改后 `/reload` 或新开 Pi 会话。已有旧实例仍使用旧工具定义；切换前处理完其活动运行。

需要 npm 安装的 Pi SDK 与 Node.js 22.18+。当前运行器通过宿主 SDK 的绝对路径与原有 peer alias 解析加载；不自动切换到另一个 Pi 安装或外部 CLI。Standalone/Bun 打包版不在当前支持范围。

## 启动

```javascript
subagent({ task: "读取指定目录并回答问题，不修改文件。" })
subagent({
  task: "核对本次修改。",
  options: {
    requirementsFile: "./requirements/check.md",
    model: "shared:lowCost",
    context: "fresh"
  }
})
```

- 不传 `action` 为新运行，`task` 必填。没有 `agent`、内置角色、自定义角色目录、工作流脚本、自动审核或验收参数。
- 启动设置放在 `options` 对象中：`requirementsFile`、`model`、`maxDepth`、`context`、`cwd`、`timeoutMs`。省略 `options` 即使用默认值；运行时拒绝未知字段和错误类型。`async` 保持为顶层参数，启动和恢复均可使用。
- `options.requirementsFile` 是 UTF-8 `.md` 文件，相对路径基于**调用者 cwd**，不受 subagents 的 `options.cwd` 参数影响。启动前检查并读取，读取失败、非法 UTF-8 或非普通文件明确报错，不启动 subagents。
- 实际内容、来源路径和 SHA-256 保存在本次 `contract.json`。恢复直接使用这一快照，不再读取原 MD；删除或修改源文件不影响恢复。
- `options.model` 默认继承父会话的确切 provider/model 和 thinking level。可传 `shared:lowCost`，复用 `~/.pi/agent/shared-models.json` 解析，也可显式传 `provider/model[:thinking]`。
- shared 配置、模型或凭据不可用会失败；运行时接口错误记录为失败，不换模型。Pi 自身同模型重试由常规 Pi 设置控制。
- `options.cwd` 默认调用者目录，`options.timeoutMs` 默认 30 分钟，超时暂停而非重新执行。
- `async` 默认 `true`，返回 ID 后由完成通知唤醒父会话；`false` 等待同一个运行器完成，交互界面中的进度放在底部固定区域，模型结果由工具返回，不再向模型追加完成通知。同步恢复遵循同样规则。不存在能力不同的第二条前台执行链。
- 对仍在运行的异步任务调用 `wait`，完成结果由等待调用接收，不再追加通知；中断等待后恢复异步通知。已经发送的通知不会因后续查询而撤回。subagents 主动 `report` 不受完成通知去重影响。

## 可视化

交互模式的调用卡片显示任务简述，启动回执保持静态：首行显示运行 ID 与模型，次行显示原始任务提示，换行压成空格并按终端宽度截断，最多占一行，展开时也不换行。进度位于输入区下方，按实际节点数伸缩，不补空白行，最多占 8 行（含标题及溢出提示），以父子树展示仍有活动运行的任务组，组内已结束的后代保留状态。每个节点只占一行：状态、任务首句截短、`tools 3 · $0.03`、最新消息末段；长行限宽，不自动换行。统计仅计该运行自身，费用取运行时记录的估算值；缺失显示 `—`，不表示服务商账单或剩余额度。节点超出可用行数时末行显示 `more N agents...`，通过 `/subagents` 查看全部。

`steer / resume / interrupt / cancel` 工具回执使用中文操作说明，显示目标任务与补充指令，不直接展示原始 JSON。`steer` 明确为“已入队，等待子代理处理”，不代表已执行；恢复显示旧 → 新运行 ID 及返回时状态，暂停／取消按实际返回状态显示是否完成及能否恢复。任务与指令默认各一行截短，展开显示完整多行内容和 ID。操作回执保持静态，后续结果仍由原有进度和完成记录展示；模型侧返回协议不变。

消息预览只使用模型普通文本或工具执行简介，并将末段的换行去掉。执行工具时优先保留模型调用前的说明；没有说明则显示工具名，读取、写入和编辑工具可带文件路径。不展示思考正文、工具参数、文件内容或工具返回全文；完整记录仍保留。

运行结束时在会话尾部追加一条仅用户可见的结果记录，不回写旧启动卡片。并发和后代运行各追加一次，包含任务、ID、深度及父运行标识。记录使用 Pi 自定义 entry 持久化，恢复会话后仍可查看，不进入模型上下文、不触发模型调用；原有模型结果回收与异步完成交付不变。打开历史会话不批量重播既有完成记录。

结果默认预览末尾 4 个逻辑行，按 Pi 当前绑定的快捷键展开（默认 Ctrl+O），展开后完整显示。全部结束后底部区域隐藏并停止定时刷新，新运行启动时恢复；没有内容变化时不重绘。界面名称为 `subagents`，工具标识为 `subagent`。

进度快照属于展示缓存：Windows 暂时拒绝替换 `progress.json` 时保留旧快照，记录非致命错误，下一次正常更新再写入，不中断任务。最终状态以运行记录为准，不使用残留的“输出中”覆盖失败或完成；模型尚未返回用量时显示未知值。

`/subagents` 打开完整边框的独立焦点面板，上方代理列表与下方内容区分隔，默认选中活动代理并显示最新对话，而不是从初始任务提示开始。`1 会话` 查看带角色标签的会话及尚未落盘的实时输出，`2 输出` 查看当前输出或最终产物；运行中工具的增量日志在会话和输出页均可查看，`3 任务` 单独查看完整提示、模型与 thinking、深度和文件路径。没有会话文件时，会话页回退到已有输出；失败原因会显示在内容尾部。

- `←/→` 切换代理；`1/2/3` 直接切页，`Enter/Tab` 循环切页。
- `↑/↓` 或 `j/k` 按行滚动，`PgUp/PgDn` 翻页，`Home` 到开头，`End` 到末尾。fullscreen 模式还支持滚轮；regular 模式的滚轮由终端管理，请使用键盘翻页。
- 会话和输出页默认跟随最新内容；向上滚动后固定当前内容快照，避免长流式输出截断或消息落盘挪动正在阅读的段落，`End` 接回最新内容。页脚显示可见行范围及跟随／历史快照状态；历史快照期间代理状态继续更新，但正文保持不变。不再提供含义不明的手动刷新按钮。`Esc` 关闭。
- `p` 暂停、`D` 取消、`c` 恢复、`s` 补充任务；暂停、取消和恢复需要确认。后代记录可查看，控制须交给其所属父代理。
- 非交互模式仍使用工具返回结果和保存的运行文件，不打开界面。

## 上下文与工具

`options.context: "fresh"` 是默认值：不复制父会话历史或父系统提示词。`options.context: "fork"` 显式复制父会话当前分支的对话上下文，包含压缩摘要，但不复制父系统提示词。选择 fork 就意味着原对话中的要求也可能影响 subagents。

subagents 加载当前环境的工具、已配置扩展、skills 和 AGENTS.md，但固定排除父会话负责的 `task_list`、`task_add`、`question`、`scratchpad`、`memory_write`、`memory_forget`、`memory_restore`。排除同时移除工具定义、工具摘要和使用指南，后续动态注册也不能重新开放。记忆搜索、读取和状态查询保留。`task-list/index.ts` 扩展的生命周期处理器不绑定到子会话，因此其看门狗、任务上下文注入和扩展自定义自动压缩均不运行；Pi 原生压缩不受影响。新建、fork、恢复及各层后代统一适用，父会话不变。`events.jsonl` 的 `child_tool_policy_applied` 记录排除工具与禁用扩展路径。

本扩展不扫描角色目录，不自动加载业务方法要求，也不附加独立审核标准。恢复保留原对话和任务快照，但环境扩展、AGENTS.md 等仍从当前环境加载。全局规则不是此扩展的重写对象；更严格的禁止派生指令仍需遵守。

每个运行使用独立 Node 进程，避免扩展模块状态和环境变量污染父会话。环境扩展加载失败明确失败；不以关闭扩展或禁用工具作为自动补救。

## 派生边界

```javascript
subagent({ task: "按任务要求分层检索。", options: { maxDepth: 2 } })
```

根父会话为深度 0，`options.maxDepth` 默认为 1，只允许启动一层。显式设置为 2 时第一层可再启动一层。后代默认继承原绝对上限，剩余深度为 `maxDepth - depth`，只能降低、不能增加或重置。恢复沿用原深度，不重新计为第一层。

深度上限绑定在运行器闭包，后代不能通过参数增大上限。达到最大深度时，不注册或提供 `subagent` 工具；未达到时提供该工具，后续调用仍受继承上限约束。

派生深度限制仅作用于 `subagent` 工具；前述父会话工具排除独立于深度生效。Bash、脚本、远端命令照常使用，本扩展不检查或拦截其中的 Pi、Codex 等命令。

## 状态、取消与恢复

```javascript
subagent({ action: "list" })
subagent({ action: "status", id: "完整运行 UUID" })
subagent({ action: "result", id: "完整运行 UUID" })
subagent({ action: "wait", id: "完整运行 UUID" })
subagent({ action: "steer", id: "完整运行 UUID", message: "补充本次任务信息。" })
subagent({ action: "interrupt", id: "完整运行 UUID" })
subagent({ action: "resume", id: "完整运行 UUID", message: "从已完成进度继续，不重复提交。" })
subagent({ action: "cancel", id: "完整运行 UUID" })
```

- 状态为 queued、running、completed、failed、paused、cancelled。completed 仅表示运行协议正常结束，不代表业务验收通过。
- `interrupt` 可恢复；`cancel` 终止且不可恢复。只向本实例确实拥有的子进程发送控制，不按模糊 PID/端口清理。中断 `wait` 只停止等待，异步运行仍可管理；要停运行需明确 cancel/interrupt。
- `resume` 返回新 ID，复制原会话至新目录，保留原模型、要求、深度、cwd 和上下文；管理操作不接受 `task` 或 `options`，不能覆盖这些启动参数。已恢复的旧 ID 指向后继，拒绝重复恢复。
- 遇到超时、连接中断等可能恢复的错误时，调用方先轻量查看状态和最近输出，确认已完成进度、剩余工作及已发生的副作用；仅在信息不足时补查相关事件日志或会话。任务仍在运行则继续等待；已停止且可恢复、有剩余工作时，优先主动调用 `resume`，在原授权范围内不必仅因这类错误再次征求确认。恢复消息指出剩余工作，不重复已完成动作，不默认新开任务或换模型。用户主动停止、存在明确阻塞，或反复恢复仍无进展时，暂停并说明。这是调用方提示词，不是运行器自动重试机制。
- 启动前失败且尚未提交 prompt 时可重试原任务；prompt 已开始而会话文件丢失时拒绝自动重放。
- 父会话退出或 reload 会暂停其子运行；进程意外退出留下的非终态记录在查询时明确标为失败。旧角色版运行不自动迁移，不假装继承其策略。
- `subagent` 工具可用的 subagents 可用 `subagent({ action: "report", message: "需要父线程确认的信息" })` 非阻塞报告；叶子 subagents 通过正常回复交回结果。父线程可通过 steer 补充信息。

状态和产物放在 Windows `%LOCALAPPDATA%/PiSubagents/<父会话ID>/<运行ID>/`，其他系统以临时目录代替 LOCALAPPDATA。子运行目录含 `contract.json`、`status.json`、`progress.json`、`events.jsonl`、`runner.log`、`session/`、`output.md`。后代记录在父运行的 `children/` 中。工具文本超过 24,000 字符时截断，完整结果读取 `outputPath`。不自动删除恢复材料。

## 配置

`~/.pi/agent/extensions/subagent/config.json` 只接受：

```json
{
  "asyncByDefault": true,
  "timeoutMs": 1800000
}
```

未知键明确报错，避免旧角色/验收配置被静默带入。shared 模型配置保持原格式：

```json
{
  "lowCost": { "provider": "your-provider", "model": "your-model" }
}
```

`options` 在工具协议中采用开放的配置对象，由执行器校验其实际字段和类型。普通可选参数无需依赖模型的 strict 兼容配置。

## 开发验证

```bash
npm install --include=dev
npm run typecheck
npm test
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/package.mts
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi npm run test:integration
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/startup-cancel.mts
```

单元测试覆盖要求快照、模型解析、深度、运行提示、完成交付归属和实时进度。集成测试使用真实宿主 SDK/进程/扩展与本地确定性 OpenAI 协议服务，不依赖模型推理；覆盖默认调用、MD、模型、工具可用性、派生、Bash/脚本执行、失败恢复、取消与通知。测试打印证据目录，结束时关闭本次创建的服务和子进程。在线供应商冒烟验证需单独运行并如实记录结果。

在 Pi shell 中运行以下测试，会使用当前选定的 OpenAI Responses 模型自主生成 `subagent` 调用参数，并启动真实 subagents，验证默认工具可用性、中文 MD 与低成本选择、两层派生及禁止增加深度、101 行输出、暂停后恢复原要求快照；测试同时断言同步结果没有完成通知、请求中不发送 `strict`，会产生实际模型请求：

```bash
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/tool-call-smoke.mts
```

界面测试使用真实宿主组件，验证渲染、选择、滚动、控制按钮和生命周期；不发送模型请求：

```bash
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/ui.mts
```

该测试输出 `fixture.json` 路径。Windows 安装 `pywinpty`、`pyte` 后，可用以下命令在独立 ConPTY 中启动实际 Pi，验证面板刷新、详情、会话切换和关闭。使用的是界面测试记录，不会执行真实子任务；退出时清理本次创建的 Pi 进程。

```bash
python3 test/ui-pty.py <fixture.json绝对路径>
python3 test/ui-inspector-pty.py <fixture.json绝对路径>
```

`ui-inspector-pty.py` 在 regular/fullscreen 两种实际终端模式中验证完整外框、默认最新对话、长提示隔离、键盘翻页、自动更新保持阅读位置、实时输出、切换代理和关闭恢复；fullscreen 额外验证滚轮。使用 `ui.mts` 生成的独立 fixture，不发送模型请求。

Windows 文件占用回归测试会拒绝替换进度文件，检查流式输出仍然完成、旧快照保持有效、解锁后更新恢复且没有临时文件泄漏：

```bash
python3 test/progress-lock.py
```

真实模型多行输出可单独运行。其父会话保存在证据目录；将生成的 `results.json` 作为第二个参数传给伪终端测试，可回放实际调用卡片并检查全部 101 行的展开与分页，不重复执行模型任务：

```bash
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/tool-call-smoke.mts multiline
python3 test/ui-pty.py <fixture.json绝对路径> <results.json绝对路径>
```

滚动回归测试覆盖宽行、空输出、静态回执、尾部完成记录及 regular 模式的清滚动历史指令。生成的 `fixture.json` 可用于实际 Pi 进程中的并发和三层树状展示验证，同时检查工具详情不进入底部预览；fullscreen 模式发送滚轮事件，检查历史中段的阅读位置：

```bash
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/ui-scroll.mts
python3 test/ui-live-pty.py <fixture.json绝对路径>
```
