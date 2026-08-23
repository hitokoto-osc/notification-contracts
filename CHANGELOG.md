# Changelog

本文件记录契约的所有值得注意的变更，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0]

首个版本，与线上行为 **1:1 照相**，不含任何改进。这样后续每一次 `asyncapi diff`
都有一个干净、可信的基线。

### Added

- 八条 RabbitMQ 通道的拓扑快照（exchange / routing key / queue / DLX / consumer 配置）。
- 六个业务消息的 payload schema。
- 死信收集器契约（载荷为六个业务 schema 的 `anyOf`，**不是**包装体）。
- 死信桶契约（`{header, body}` 包装体，`body` 为 JSON 字符串）。
- 正样本 7 个 + 负样本 6 个，双向校验。

### 已知的偏松处

以下是**线上现状**，不是设计意图。收紧它们都属于 MAJOR 变更，需要四语言生产者同步：

- `hitokoto_moved.operate` 与 `hitokoto_reviewed.status` 未列入 `required`——
  消费侧这两个字段没有 `validate` 标签，缺失时静默落到零值 `0`（NotOpen）。
- `poll_daily_report` 的各计数字段未列入 `required`，同样会静默落到 `0`。
- 所有 schema 都不设 `additionalProperties: false`——消费侧用 sonic 反序列化，
  未知字段被忽略；收紧会把现存流量判成不合规。
