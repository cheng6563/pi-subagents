# Pi 通用子代理执行器

这是基于原 pi-subagents 运行时代码裁剪、独立维护的实现。保留 MIT 许可及历史提交，不常规合并或同步上游；只按需评估具体修复。仅提供一个通用 `subagent` 执行器，任务方法与业务标准由调用方提供。

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
  requirementsFile: "./requirements/check.md",
  model: "shared:lowCost",
  context: "fresh"
})
```

- 不传 `action` 为新运行，`task` 必填。没有 `agent`、内置角色、自定义角色目录、工作流脚本、自动审核或验收参数。
- `requirementsFile` 是 UTF-8 `.md` 文件，相对路径基于**调用者 cwd**，不受子代理 `cwd` 参数影响。启动前检查并读取，读取失败、非法 UTF-8 或非普通文件明确报错，不启动子代理。
- 实际内容、来源路径和 SHA-256 保存在本次 `contract.json`。恢复直接使用这一快照，不再读取原 MD；删除或修改源文件不影响恢复。
- `model` 默认继承父会话的确切 provider/model 和 thinking level。可传 `shared:lowCost`，复用 `~/.pi/agent/shared-models.json` 解析，也可显式传 `provider/model[:thinking]`。
- shared 配置、模型或凭据不可用会失败；运行时接口错误记录为失败，不换模型。Pi 自身同模型重试由常规 Pi 设置控制。
- `cwd` 默认调用者目录，`timeoutMs` 默认 30 分钟，超时暂停而非重新执行。
- `async` 默认 `true`，返回 ID 后由完成通知唤醒父会话；`false` 等待同一个运行器完成。不存在能力不同的第二条前台执行链。

## 上下文与工具

`context: "fresh"` 是默认值：不复制父会话历史或父系统提示词。`context: "fork"` 显式复制父会话当前分支的对话上下文，包含压缩摘要，但不复制父系统提示词。选择 fork 就意味着原对话中的要求也可能影响子代理。

子代理正常加载当前环境的工具、已配置扩展、skills 和 AGENTS.md；本扩展不扫描角色目录，不自动加载业务方法要求，也不附加独立审核标准。恢复保留原对话和任务快照，但环境扩展、AGENTS.md 等仍从当前环境加载。全局规则不是此扩展的重写对象；更严格的禁止派生指令仍需遵守。

每个运行使用独立 Node 进程，避免扩展模块状态和环境变量污染父会话。环境扩展加载失败明确失败；不以关闭扩展或禁用工具作为自动补救。

## 派生边界

```javascript
subagent({ task: "按任务要求分层检索。", maxDepth: 2 })
```

根父会话为深度 0，默认 `maxDepth: 1` 只允许启动一层。显式 `maxDepth: 2` 时第一层可再启动一层。后代默认继承原绝对上限，剩余深度为 `maxDepth - depth`，只能降低、不能增加或重置。恢复沿用原深度，不重新计为第一层。

深度授权绑定在运行器闭包，后代不能通过参数增大执行器额度。额度耗尽时，不注册或提供 `subagent` 工具；尚有额度时提供该工具，后续调用仍受继承上限约束。

限制仅作用于 `subagent` 工具。Bash、脚本、远端命令及其他工具和扩展照常使用，本扩展不检查或拦截其中的 Pi、Codex 等命令。

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
- `resume` 返回新 ID，复制原会话至新目录，保留原模型、要求、深度、cwd 和上下文；管理操作不接受覆盖这些启动参数。已恢复的旧 ID 指向后继，拒绝重复恢复。
- 启动前失败且尚未提交 prompt 时可重试原任务；prompt 已开始而会话文件丢失时拒绝自动重放。失败后先查看状态、日志、产物与已发生的副作用，再恢复。
- 父会话退出或 reload 会暂停其子运行；进程意外退出留下的非终态记录在查询时明确标为失败。旧角色版运行不自动迁移，不假装继承其策略。
- `subagent` 工具可用的子代理可用 `subagent({ action: "report", message: "需要父线程确认的信息" })` 非阻塞报告；叶子子代理通过正常回复交回结果。父线程可通过 steer 补充信息。

状态和产物放在 Windows `%LOCALAPPDATA%/PiSubagents/<父会话ID>/<运行ID>/`，其他系统以临时目录代替 LOCALAPPDATA。子运行目录含 `contract.json`、`status.json`、`events.jsonl`、`runner.log`、`session/`、`output.md`。后代记录在父运行的 `children/` 中。工具文本超过 24,000 字符时截断，完整结果读取 `outputPath`。不自动删除恢复材料。

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

## 开发验证

```bash
npm install --include=dev
npm run typecheck
npm test
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi npm run test:integration
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=/absolute/path/to/installed/pi node --experimental-strip-types test/startup-cancel.mts
```

单元测试覆盖要求快照、模型解析、深度与运行提示。集成测试使用真实宿主 SDK/进程/扩展与本地确定性 OpenAI 协议服务，不依赖模型推理；覆盖默认调用、MD、模型、工具可用性、派生、Bash/脚本执行、失败恢复、取消与通知。测试打印证据目录，结束时关闭本次创建的服务和子进程。在线供应商冒烟验证需单独运行并如实记录结果。
