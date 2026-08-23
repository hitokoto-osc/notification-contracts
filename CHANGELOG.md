# Changelog

本文件记录契约的所有值得注意的变更，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
## [1.2.0]

多模型审计后的修正。全部是**放宽**，既有合规流量不受影响。

### Changed

- `hitokoto_reviewed.reviewer_uid`、`poll_finished.id`、`poll_finished.point` 由 `minimum: 1`
  改为 `not: { const: 0 }`。消费侧这三个字段是有符号 `int` 且只标了 `required`，Go 只拒 `0`、
  不拒负数；原来的 `minimum: 1` 比消费侧更严，不是照相。
- `poll_daily_report` 的 14 个计数字段去掉 `minimum: 0`。消费侧既无 `validate` 标签也非无符号
  类型，这个下界是凭空发明的。
- `notification_failed_can.header` 接受 `null`。`wrapperHeader` 直接序列化 `delivery.Headers`，
  消息没有头部时该字段就是 `null`——而头部无法解析恰恰是消息被转投死信桶的主要原因之一，
  这条路径完全可达，原来的 schema 会把死信桶里的真实消息判成不合规。

### Tooling

- `validate-examples.mjs` 现在从 `asyncapi.yaml` 解析 `channel → message → payload $ref`，
  样本按 channel 而非写死的 schema 文件名校验。此前把某条 message 的 payload 改指到别的
  schema，所有检查都会全绿——没有任何 schema 文件发生变化。同时新增：每个 channel 必须被
  恰好一个 operation 引用；死信收集器的 `anyOf` 必须真能接住六条业务样本；
  `x-enumNames` 的长度、标识符合法性与 `description` 表格的取值覆盖必须与 `enum` 一致。
- `check-payload-compat.mjs` 大幅加固：fail closed（读不到目录直接炸，不再退化成放行）、
  比对 `$ref` 与全部约束关键字、`allOf`/`anyOf` 按无序分支集合比对（消除下标漂移与重排假阳性）、
  `type` 按集合包含判断（`"object"` → `["object","null"]` 是放宽）。
  新增「需人工确认」分类：同一节点上既加约束又删约束时方向无法自动判定，用 `compat-reviewed`
  标签放行且不要求升 MAJOR。
- `check-major-bump.mjs`：打了 `topology-change` / `breaking-change` 的 PR 必须真的升 MAJOR。
  此前标签只是关掉门禁的开关，破坏性改动可以贴着标签停在原版本号合入。
- CI 的三道兼容性门禁现在被标签统一让路。此前打了 `topology-change` 的 PR 仍会被
  `asyncapi diff` 拦下，逃生门等于不存在。

### Docs

- README §1 拆出死信路由（那张表的读者是外部生产方），首屏给出可直接复制的完整载荷，
  并显式警告时间字段是字符串。
- README §3 增加 `event_id` / `uuid` / `id` 三类标识符对照表。
- `.gitattributes` 修正角色：那四个服务是**生产方**，`notification_worker` 是唯一消费方。


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
