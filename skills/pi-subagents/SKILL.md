---
name: pi-subagents
description: "Use when the operator requests delegation with the independent generic subagent executor, including task/Markdown handoff, shared:lowCost selection, explicit nesting depth, status, cancellation or resume."
---

# 通用子代理工具

把本次任务放在 `task`，需要的方法要求通过 `requirementsFile` 指向 UTF-8 Markdown。不传角色名，不使用旧版工作流、agent 配置或验收参数。

```javascript
subagent({ task: "本次具体任务", requirementsFile: "./requirements.md" })
subagent({ task: "本次具体任务", model: "shared:lowCost" })
```

默认继承父模型，fresh 不带父会话历史或系统提示词；普通环境工具、扩展、skills、AGENTS.md 仍加载。只有明确需要父对话时才选择 `context: "fork"`。方法和审核标准来自任务/要求文件，执行器不推断。

默认最大深度 1。仅在当前授权和项目规则允许时显式设置 `maxDepth` 开启后代；后代继承剩余深度且不能增加上限。额度耗尽时子代理没有 `subagent` 工具。此限制只控制该工具，不限制 Bash、脚本或其他工具和扩展。

异步默认返回 ID，完成后通知父线程。用 `status` 查看状态，`result` 回收结果；完整内容读取返回的 `outputPath`。需要同轮等待可用 `async: false` 或 `action: "wait"`。多个独立任务可分别调用同一个执行器；共享文件写入仍须避免冲突。

失败先检查 `status`、`events.jsonl`、会话和已有产物。可恢复时调用 `subagent({ action: "resume", id, message })`，后续使用新 ID；恢复沿用原实际加载的要求、模型与深度，不重新读 MD。不可通过恢复改模型或扩大权限。

`interrupt` 暂停可恢复，`cancel` 终止不可恢复。工具可用的子代理可用 `action: "report"` 向父线程报告，叶子通过正常回复交回结果；父线程用 `steer` 补充信息。不要因失败状态自动重做已完成的外部操作。

完整运行与配置说明见 [README](../../README.md)。
