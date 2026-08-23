# notification-contracts

hitokoto-osc 通知域 RabbitMQ 消息契约的**单一事实源**。

消费方是 [`hitokoto-osc/notification_worker`](https://github.com/hitokoto-osc/notification_worker)（Go）；
生产方目前有 Go / PHP / JS / Rust 四个服务。任何一方想改消息格式，都从这个仓库的 PR 开始。

不需要懂 AsyncAPI 也能用这个仓库：直接看下面的速查表，抄 `examples/` 里的样本即可。

---

## 1. 我要发一条消息（60 秒版）

**第一步**：在下表找到你的事件，拿到 exchange 与 routing key。

| 事件 | exchange | routing key | queue | schema | 样本 |
| --- | --- | --- | --- | --- | --- |
| 句子投稿成功 | `notification` | `notification.hitokoto_appended` | `hitokoto_appended` | [`hitokoto-appended`](schemas/hitokoto-appended.schema.json) | [样本](examples/hitokoto_appended.json) |
| 句子审核完成 | `notification` | `notification.hitokoto_reviewed` | `hitokoto_reviewed` | [`hitokoto-reviewed`](schemas/hitokoto-reviewed.schema.json) | [样本](examples/hitokoto_reviewed.json) |
| 句子被移动分类 | `notification` | `notification.hitokoto_moved` | `hitokoto_moved` | [`hitokoto-moved`](schemas/hitokoto-moved.schema.json) | [样本](examples/hitokoto_moved.json) |
| 投票创建 | `notification` | `notification.hitokoto_poll_created` | `hitokoto_poll_created` | [`poll-created`](schemas/poll-created.schema.json) | [样本](examples/hitokoto_poll_created.json) |
| 投票结束 | `notification` | `notification.hitokoto_poll_finished` | `hitokoto_poll_finished` | [`poll-finished`](schemas/poll-finished.schema.json) | [样本](examples/hitokoto_poll_finished.json) |
| 每日审核员报告 | `notification` | `notification.hitokoto_poll_daily_report` | `hitokoto_poll_daily_report` | [`poll-daily-report`](schemas/poll-daily-report.schema.json) | [样本](examples/hitokoto_poll_daily_report.json) |

`notification` exchange 是 `direct` + `durable`，六个队列都是 `durable`，且都把死信指向
`notification_failed` / `notification_failed.notification_failed_collector`。

> `queue` 一列只是给排障时对照用的。**生产者不需要也不应该声明队列**——AMQP 0-9-1 发布消息
> 只需要 exchange 与 routing key，队列由 `notification_worker` 启动时声明。

> 死信收集器与死信桶那两条路由由 `notification_worker` 内部使用，见 [§5 死信机制](#5-死信机制)。

**第二步**：抄下面这段，把值换成你的。所有消息都是 `application/json`。

```json
{
  "to": "a632079@qq.com",
  "uuid": "701fd013-65eb-4813-85e3-0f74bc53a95f",
  "hitokoto": "落霞与孤鹜齐飞，秋水共长天一色。",
  "from": "滕王阁序",
  "from_who": "王勃",
  "type": "i",
  "creator": "测试用户",
  "created_at": "1696347595"
}
```

> ⚠️ **`created_at` 是字符串，不是整数。** PHP 里顺手写 `time()`、JS 里写 `Date.now()` 都会
> 得到数字，消费侧会直接判错并把消息打进死信。记得 `(string)` / `String(...)` 一下。

其余五个事件在上面的表格里各有一份完整样本，格式同理——都是这个底座加几个字段。

**第三步**（可选）：把 `schemas/` 目录 vendor 进你的项目，用任意 JSON Schema（draft-07）库
在发送前自校验一次。

### 契约的方向性

本仓描述的是**生产者被允许发送什么**，不是消费者能容忍什么（Postel's law）。

- 消费者比契约更宽松 → **合规**。比如 `created_at` 消费侧其实还能吃 `now`、`yesterday`，
  但契约不允许你发。
- 消费者比契约更严格 → **缺陷**，必须修。

`notification_worker` 侧的回归测试断言方向恒为 `examples/ → Go 校验器必须通过`，
正是为了抓后一种情况。

---

## 2. 枚举速查

### HitokotoType（句子分类，字符串）

| 值 | 名称 | 含义 |
| --- | --- | --- |
| `a` | Anime | 动画 |
| `b` | Comic | 漫画 |
| `c` | Game | 游戏 |
| `d` | Literature | 文学 |
| `e` | Original | 原创 |
| `f` | Internet | 来自网络 |
| `g` | Other | 其他 |
| `h` | Video | 影视 |
| `i` | Poetry | 古诗词 |
| `j` | NetEase | 网易云音乐 |
| `k` | Philosophy | 哲学 |
| `l` | Joke | 抖机灵 |

### PollStatus（投票状态，整数）

取值不连续，分三段：`0-2` 生命周期，`100-102` 人工干预，`200-202` 终结态。

| 值 | 名称 | 含义 |
| --- | --- | --- |
| `-1` | Unknown | 未知，比如投票不存在 |
| `0` | NotOpen | 未开放投票 |
| `1` | Open | 投票正常开放 |
| `2` | Processing | 处理中，停止投票 |
| `100` | Suspended | 暂停投票 |
| `101` | Closed | 关闭投票 |
| `102` | OpenForCommonUser | 开放给普通用户投票 |
| `200` | Approved | 赞同（入库） |
| `201` | Rejected | 驳回 |
| `202` | NeedModify | 需要修改（邮件里显示为「亟待修改」） |

### PollMethod（审核员投票方式，整数）

| 值 | 名称 | 含义 |
| --- | --- | --- |
| `1` | Approve | 赞同 |
| `2` | Reject | 驳回 |
| `3` | NeedModify | 需要修改 |
| `4` | NeedCommonUserPoll | 需要普通用户投票 |

**别把两者搞混**：`PollMethod` 描述*单个审核员投了什么票*，`PollStatus` 描述*整个投票的结果*。

---

## 3. event_id 怎么填

所有业务消息都接受一个**可选**的顶层字段 `event_id`：

```json
{ "event_id": "0191d9c6-6f7c-7c3a-9f4e-3f5b2c1d8a90", "to": "..." }
```

同一条消息里最多会同时出现三个「标识符」，先把它们分清楚：

| 字段 | 类型 | 必填 | 标识的是 | 出现在 |
| --- | --- | --- | --- | --- |
| `event_id` | UUID 字符串（建议 v7） | 否 | **这次事件**，重发时复用同一值 | 所有消息 |
| `uuid` | UUID 字符串（**必须 v4**） | 是 | **那句一言**，句子的永久标识 | 五条句子相关消息（每日报告除外） |
| `id` | 整数 | 是 | **那次投票**，投票记录的主键 | `poll_created` / `poll_finished` |

最常见的错误是把 `id` 当成事件标识来填。它不是——它是投票记录的整数主键，
同一次投票的「创建」和「结束」两条事件共享同一个 `id`，但它们是两次不同的事件。

`event_id` 是这条事件的不可变身份，语义对齐 CloudEvents 的 `id`。三条规则：

1. **推荐 UUIDv7**。自带时间序，消费侧可以按前缀清理去重桶。
2. **重发必须复用同一个值**。同一逻辑事件重试、补发、回放时换了新值，去重就失效了。
3. **不填也合法**。消费侧此时回退到对规范化字段求哈希的启发式去重键，
   精度低于精确幂等——能填就填。

> 契约刻意没有复用 `id` 这个名字：它在这两条消息里已经被整数占用，再塞一个字符串进去
> 会产生同一字段同时要求 string 与 integer 的不可满足 schema。

---

## 4. 时间字段能填什么

所有时间字段（`created_at` / `operated_at` / `updated_at`）都是**字符串**，五种形态：

| 形态 | 例子 |
| --- | --- |
| Unix 秒级时间戳 | `"1696347595"` |
| Unix 毫秒级时间戳 | `"1696347595000"` |
| Unix 微秒级时间戳 | `"1696347595000000"` |
| Unix 纳秒级时间戳 | `"1696347595000000000"` |
| ISO 风格日期时间 | `"2026-08-23T12:34:56+08:00"` / `"2026-08-23 12:34:56"` / `"2026-08-23"` |

数字串只认 10 / 13 / 16 / 19 位，**其它长度会被消费侧直接判错**（比如 9 位或 11 位）。

契约刻意没有用 `format: date-time`——那会强制 RFC3339，把线上真实在跑的
`"1696347595"` 和 `"2026-08-23 12:34:56"` 全部判成不合规。

---

## 5. 死信机制

```text
                 ┌──────────────────────────┐
   6 个业务队列 ──┤ 处理失败 → broker 死信转发 ├──▶ notification_failed_collector
                 └──────────────────────────┘              │
                                                           │ 读 x-death 累计次数
                                          ┌────────────────┴────────────────┐
                                          │ count <= 5：sleep 4^count 秒后   │
                                          │ 按 x-first-death-* 重投回原队列  │
                                          │ count > 5：转投死信桶            │
                                          └────────────────┬────────────────┘
                                                           ▼
                                              notification_failed_can
```

这两条路由由 `notification_worker` 内部使用，**外部生产者不要往这里发消息**：

| 用途 | exchange | routing key | queue | schema |
| --- | --- | --- | --- | --- |
| 死信收集器 | `notification_failed` | `notification_failed.notification_failed_collector` | `notification_failed_collector` | 六个业务 schema 的 `anyOf` |
| 死信桶 | `notification_failed` | `notification_failed.notification_failed_can` | `notification_failed_can` | [`notification-failed-can`](schemas/notification-failed-can.schema.json) |

两个要点，最容易踩：

1. **收集器收到的是原始业务消息**，不是包装体。broker 的死信转发不改写 body，
   只追加 `x-death` / `x-first-death-exchange` / `x-first-death-queue` 头部。
2. **只有死信桶（can 队列）用 `{header, body}` 包装体**，且 `body` 是原始消息体的
   **JSON 字符串**（需要解析两次）。见 [`notification-failed-can.schema.json`](schemas/notification-failed-can.schema.json)。

收集器的死信路由指回它自己，所以它的处理逻辑对无法解析的头部**不能返回错误**——
那会造成热循环——只能直接转投死信桶。

---

## 6. AsyncAPI AMQP binding 的能力边界

`asyncapi.yaml` 用的 AMQP binding 是 `0.3.0`。它**表达不了**这些东西：

- routing key 字段
- queue arguments（`x-dead-letter-*`）
- exchange ↔ queue 的绑定关系
- consumer tag、prefetch

因此本仓约定三条降级写法：

| 信息 | 落在哪里 |
| --- | --- |
| routing key | `channel.address`（binding 用 `is: routingKey`） |
| queue + DLX 参数 | channel 上的 `x-rabbitmq-queue` 扩展 |
| consumer tag / prefetch / ackByError | operation 上的 `x-consumer` 扩展 |

**不要把这些字段塞进 `bindings.amqp` 内部**——那会破坏 binding schema 校验。
这是 binding 的真实能力边界，不是本仓偷懒。

### 工具链的三个实测结论（都已固化成检查，改之前先读）

**一、schema 一律不写 `$id`。**
`asyncapi bundle` 会把 `$id` 当作解析相对 `$ref` 的 base URI。一旦 `$id` 是 `https://…`，
`$ref: "./common/hitokoto-base.schema.json"` 就会被解析成一个远程地址并尝试下载，bundle 直接失败——
而 `asyncapi validate` 却会放行，形成“validate 绿、bundle 红”的陷阱。
`scripts/validate-examples.mjs` 会在发现任何 `$id` 时报错。

**二、`asyncapi diff --type breaking` 的覆盖面比想象中窄得多。**
这是在本仓实测出来的，不是推测：

| 改动 | `--type breaking` 的表现 | 谁来拦 |
| --- | --- | --- |
| 改 `channel.address`（routing key） | 判为 breaking，非零退出 | `asyncapi diff` ✅ |
| 改 `x-rabbitmq-queue` 里的 DLX / queue 名 | 只出现在 `--type all`，breaking 里看不到 | `check-topology-compat.mjs` |
| 改 `x-consumer` 的 tag / prefetch | 同上 | `check-topology-compat.mjs` |
| payload 的 `required` 新增字段 | **返回 `[]` 且以 0 退出**，完全无感 | `check-payload-compat.mjs` |
| payload 删字段 / 删 enum 取值 | 同上 | `check-payload-compat.mjs` |
| `info.version` 递增 | **误判为 breaking** | `diff-overrides.json` 改判 non-breaking |

换句话说，`asyncapi diff` 只守住了结构层，拓扑与 payload 兼容性各自需要一个自写断言。
这两个脚本不是冗余，删掉任何一个，对应那一列就彻底失防。

**三、`info.version` 递增会被判成破坏性变更。**
不加处理的话每个发版 PR 都会被自己的门禁拦下。`diff-overrides.json` 把 `/info/version`
改判为 non-breaking，CI 的 diff 步骤带 `--overrides` 运行。

> bundle 出来的文档里还带着解析器生成的 `x-parser-schema-id`，任何 payload 改动都会让它们
> 整体位移，`--type all` 因此会刷出上千条 `unclassified` 噪声。只看 `--type breaking` 即可。

---

## 7. 我要改契约

```bash
pnpm install --frozen-lockfile
pnpm test          # asyncapi validate + 正负样本校验 + 版本一致性
pnpm run bundle    # 把外置 $ref 内联，diff 的输入
```

CI 会做的事：

1. candidate 与 baseline **各自** `pnpm install` + `pnpm test` + `pnpm run bundle`
   （外置 `$ref` 必须在各自 revision 下解析，否则 diff 失真）
2. `asyncapi diff baseline candidate --type breaking --overrides diff-overrides.json`
3. `scripts/check-topology-compat.mjs` —— 拓扑逐字段比对
4. `scripts/check-payload-compat.mjs` —— payload 收紧检测

### 三个标签

| 标签 | 让路的门禁 | 是否强制升 MAJOR | 什么时候用 |
| --- | --- | --- | --- |
| `topology-change` | 全部三道 | **是** | 真的要改 routing key / queue / exchange / DLX |
| `breaking-change` | 全部三道 | **是** | 真的要收紧 payload：加必填字段、删枚举取值、加新约束 |
| `compat-reviewed` | 只让路 payload 那一道 | 否 | 检查报了「约束被替换」，人工确认其实是等价改写或放宽 |

前两个标签会额外触发 `scripts/check-major-bump.mjs`——标签的意思是「我知道这是破坏性变更」，
不是「跳过版本纪律」。第三个不会，因为它对应的本来就不是破坏性变更。

为什么需要第三个：payload 检查判断不了「同一节点上删了一个约束又加了一个」的方向。
把 `minimum: 1` 换成 `not: {const: 0}` 其实是放宽，但脚本只能报「需人工确认」；
若唯一的出口是 `breaking-change`，一次纯放宽就会被逼着升 MAJOR。

### SemVer 判定

| 改动 | 版本 |
| --- | --- |
| 加一个可选字段、放宽约束、补文档 | MINOR |
| 收紧约束、加必填字段、删枚举取值 | MAJOR，且必须打 `breaking-change` 标签 |
| 改 routing key / queue / exchange / DLX | MAJOR，且必须打 `topology-change` 标签 |
| 纯 description / 样本修正 | PATCH |

`info.version`、`package.json` 的 `version`、git tag 三者必须一致，`pnpm run check:version` 会校验。

### 四语言影响矩阵

改任何 required 字段或枚举取值前，先确认这四个仓都能跟上：

| 服务 | 语言 | 角色 |
| --- | --- | --- |
| `notification_worker` | Go | 消费方（唯一） |
| 主站 API | PHP | 生产方 |
| 前端 / BFF | JS | 生产方 |
| 数据服务 | Rust | 生产方 |

---

## 8. 消费方 / 生产方如何接入

**方式一：git submodule**（`notification_worker` 用的就是这个）

```bash
git submodule add -b main https://github.com/hitokoto-osc/notification-contracts.git contracts
```

**方式二：直接取 schema 文件**

`schemas/` 下都是标准 JSON Schema draft-07，跨文件引用是相对路径，vendor 进去即可用，
不需要任何 AsyncAPI 工具。

**渲染文档**：<https://hitokoto-osc.github.io/notification-contracts/>，每次推 `main` 由 `docs.yml`
重新生成。生成物不提交进仓库。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
