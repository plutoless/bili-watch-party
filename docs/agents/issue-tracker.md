# Issue tracker: GitHub

需求、PRD 和实现任务都记录在 `plutoless/bili-watch-party` 的 GitHub Issues。用 `gh` 操作。在新会话首次创建工单前，用 `gh repo view --json nameWithOwner` 核对目标。

## Conventions

- 创建工单时，把多行正文保存为 UTF-8 文件并用 `gh issue create --body-file <file>` 提交。
- 用 `gh issue view <number> --json number,title,body,labels,comments` 读取工单和讨论。用 `gh issue list` 按状态或标签列出工单。
- 用 GitHub 原生子工单关系记录归属。原生关系不可用时，在子工单正文中写明 `Part of #<number>`。
- 用 GitHub 原生依赖记录阻塞关系。原生依赖不可用时，在正文记录 `Blocked by: #<number>`。所有阻塞工单关闭后，该工单解除阻塞。
- 用 `gh issue edit --add-label` 或 `--remove-label` 管理标签。用 `gh issue comment --body-file <file>` 记录结果。关闭工单前，先写明完成或关闭原因。

## Pull requests as a triage surface

**PRs as a request surface: no.**

技能要求发布到 issue tracker 时，创建 GitHub 工单。技能要求获取工单时，读取正文及讨论。
