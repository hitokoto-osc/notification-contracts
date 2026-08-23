// RabbitMQ 拓扑变更的兜底断言。
//
// 为什么不能只靠 `asyncapi diff --type breaking`：
// routing key 之外的拓扑信息（queue 名、DLX 参数、consumer tag、prefetch）都放在
// `x-rabbitmq-queue` / `x-consumer` 这两个**扩展字段**里——AsyncAPI AMQP binding 0.3.0
// 表达不了它们。`asyncapi diff` 如何给扩展字段分类没有承诺，改坏 DLX 却被判成
// non-breaking 是完全可能的。这个脚本直接逐字段比对，不依赖 diff 的分类。
//
// 用法：node scripts/check-topology-compat.mjs BASELINE.yaml CANDIDATE.yaml

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { parse } from 'yaml'

const [baselineFile, candidateFile] = process.argv.slice(2)
if (!baselineFile || !candidateFile) {
  throw new Error('用法：node scripts/check-topology-compat.mjs BASELINE CANDIDATE')
}

async function topologyOf(filename) {
  const document = parse(await fs.readFile(path.resolve(filename), 'utf8'))
  const entries = []

  for (const [operationID, operation] of Object.entries(document.operations ?? {})) {
    const channelID = operation.channel?.$ref?.replace('#/channels/', '')
    const channel = document.channels?.[channelID]
    if (!channel) {
      throw new Error(`${filename}: operation ${operationID} 引用了不存在的 channel ${channelID}`)
    }

    const exchange = channel.bindings?.amqp?.exchange ?? {}
    const queue = channel['x-rabbitmq-queue'] ?? {}
    const consumer = operation['x-consumer'] ?? {}

    entries.push({
      operationID,
      channelID,
      routingKey: channel.address,
      exchange: exchange.name,
      exchangeType: exchange.type,
      exchangeDurable: exchange.durable,
      exchangeAutoDelete: exchange.autoDelete,
      queue: queue.name,
      queueDurable: queue.durable,
      queueAutoDelete: queue.autoDelete,
      queueExclusive: queue.exclusive,
      deadLetterExchange: queue.arguments?.['x-dead-letter-exchange'],
      deadLetterRoutingKey: queue.arguments?.['x-dead-letter-routing-key'],
      consumerTag: consumer.tag,
      prefetch: consumer.prefetch ?? 0,
      ackByError: consumer.ackByError
    })
  }

  return entries.sort((left, right) => left.operationID.localeCompare(right.operationID))
}

const baseline = await topologyOf(baselineFile)
const candidate = await topologyOf(candidateFile)

const changed = []
const byID = new Map(baseline.map(entry => [entry.operationID, entry]))

for (const entry of candidate) {
  const previous = byID.get(entry.operationID)
  byID.delete(entry.operationID)
  if (!previous) {
    changed.push(`+ 新增 operation ${entry.operationID}（queue ${entry.queue}）`)
    continue
  }
  for (const key of Object.keys(entry)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(entry[key])) {
      changed.push(
        `~ ${entry.operationID}.${key}: ${JSON.stringify(previous[key])} → ${JSON.stringify(entry[key])}`
      )
    }
  }
}
for (const entry of byID.values()) {
  changed.push(`- 删除 operation ${entry.operationID}（queue ${entry.queue}）`)
}

if (changed.length > 0) {
  console.error('检测到 RabbitMQ 拓扑变更：')
  for (const line of changed) console.error('  ' + line)
  console.error('')
  console.error('拓扑改动意味着线上队列需要重建或重新绑定，不能随契约悄悄合入。')
  console.error('确属有意变更时，给 PR 打上 `topology-change` 标签以跳过本检查，')
  console.error('并在同一个 PR 里升 MAJOR 版本、更新 CHANGELOG 与四语言生产者的迁移说明。')
  process.exitCode = 1
} else {
  console.log(`RabbitMQ 拓扑未变更（比对了 ${candidate.length} 条 operation）。`)
}
