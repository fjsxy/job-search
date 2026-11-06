# Issue tracker

本仓库的 spec 和 ticket 存放在 `fjsxy/job-search` 的 GitHub Issues，通过 `gh` 操作。写入前用 `gh repo view --json nameWithOwner` 核对目标仓库。

- 创建 spec 或 ticket 使用 `gh issue create --title "..." --body-file <path>`。
- 读取 ticket 使用 `gh issue view <number> --json number,title,body,labels,comments`。
- 筛选 ticket 使用 `gh issue list`，按需传入 `--state` 和 `--label`。
- 添加子 issue 使用 `gh issue edit <parent> --add-sub-issue <child>`。
- 添加阻塞关系使用 `gh issue edit <child> --add-blocked-by <blocker>`。当所有 blocker 均关闭时，ticket 才可领取。
- 更新标签使用 `gh issue edit <number>` 的 `--add-label` 或 `--remove-label`。
- 关闭前先用 `gh issue comment <number> --body-file <path>` 记录结果，再执行 `gh issue close <number>`。

**PRs as a request surface: no.**

`wayfinder` 使用带 `wayfinder:map` 标签的 issue 保存路线图，用子 issue 保存 ticket，并按类型使用 `wayfinder:<type>` 标签。按路线图顺序领取首个无人负责且无开放 blocker 的 ticket，执行 `gh issue edit <number> --add-assignee @me`。完成后记录结果、关闭 ticket，并将结论链接写回路线图。
