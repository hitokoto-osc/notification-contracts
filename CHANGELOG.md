# Changelog

本文件记录契约的所有值得注意的变更，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.0]

### Added

- 所有业务消息新增**可选**顶层字段 `event_id`（`format: uuid`），语义对齐 CloudEvents 的 `id`。
  推荐 UUIDv7；同一逻辑事件重发时必须复用同一值。

### Compatibility

- 纯 additive：`asyncapi diff v1.0.0 v1.1.0 --type breaking` 无输出。
- 既有生产者不填该字段仍然合规；既有消费者可以忽略它。
- 与 `poll_created` / `poll_finished` 的整数 `id` 互不影响——刻意不复用 `id` 这个名字，
  否则会产生同一字段要求 string 与 integer 两种类型的不可满足 schema。

### Tooling

- 新增 `scripts/check-payload-compat.mjs`：比对两个 revision 的 `schemas/`，拦截 required 新增、
  enum 取值删除、字段删除、type 变更。实测 `asyncapi diff --type breaking` 对 payload 改动
  一律返回 `[]` 并以 0 退出，这个洞必须自己补。
- 新增 `diff-overrides.json`：`asyncapi diff` 会把 `info.version` 递增判成 breaking，
  不改判的话每个发版 PR 都会被门禁拦下。

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
