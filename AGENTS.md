## Agent skills

### Issue tracker

在 `plutoless/bili-watch-party` 的 GitHub Issues 跟踪需求和实现任务。参见 [issue tracker](docs/agents/issue-tracker.md)。

### Triage labels

使用五个默认分诊标签。参见 [triage labels](docs/agents/triage-labels.md)。

### Domain docs

采用单一领域结构，术语表位于根目录的 `GLOSSARY.md`，架构决策位于 `docs/adr/`。参见 [domain docs](docs/agents/domain.md)。

## Validation

- Use the smallest reliable local check for the changed behavior. Prefer unit or
  focused integration checks when sufficient. Limit local browser coverage to
  important user journeys.
- Reuse valid evidence while the tested behavior and its relevant dependencies
  are unchanged.
- Run remote end-to-end checks only for an explicit acceptance requirement that
  depends on the deployed environment, a provider, a device, or cross-host
  behavior. Scope each check to that gap and record any required checks you defer.
- Preserve the first failure from a flaky check and isolate a smaller
  reproduction.

Follow the existing issue and release requirements.

## Public repository

仅提交源码、文档和可公开的测试样本。下载的影片、含凭证的配置、Cookie、有效邀请链接、私密房间及会话数据、本地运行日志留在仓库之外。公开验收材料使用公开或合成样本。
