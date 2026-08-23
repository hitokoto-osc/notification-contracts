// 校验 examples/、schemas/ 与 asyncapi.yaml 三者自洽。
//
// 断言链是端到端的：
//
//   example → channel → message → components.messages.<x>.payload.$ref → schema → ajv
//
// 样本刻意**不直接**绑定 schema 文件名，而是绑定 channel，再由 asyncapi.yaml 解析出 schema。
// 否则把某个 message 的 payload 改指到另一个 schema 上，这里、Go 拓扑比对、payload 文件比对
// 会同时全绿——因为没有任何一个 schema 文件发生变化。
//
// 三个方向都要跑：
//   examples/         → 必须通过对应 schema
//   examples/invalid/ → 必须被对应 schema 拒绝（只有正样本会让「放宽了约束但样本仍全绿」溜过去）
//   六个业务样本      → 必须通过死信收集器的 anyOf 合成 schema

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { parse as parseYAML } from 'yaml'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemasRoot = path.join(repositoryRoot, 'schemas')
const examplesRoot = path.join(repositoryRoot, 'examples')

// 样本 → 它所属的 channel。schema 由 asyncapi.yaml 解析得出，不在这里写死。
const positiveExamples = new Map([
  ['hitokoto_appended.json', 'hitokotoAppended'],
  ['hitokoto_reviewed.json', 'hitokotoReviewed'],
  ['hitokoto_moved.json', 'hitokotoMoved'],
  ['hitokoto_poll_created.json', 'hitokotoPollCreated'],
  ['hitokoto_poll_finished.json', 'hitokotoPollFinished'],
  ['hitokoto_poll_daily_report.json', 'hitokotoPollDailyReport'],
  ['notification_failed_can.json', 'notificationFailedCan']
])

const negativeExamples = new Map([
  ['appended_bad_uuid.json', 'hitokotoAppended'],
  ['appended_bad_type.json', 'hitokotoAppended'],
  ['appended_bad_timestamp_length.json', 'hitokotoAppended'],
  ['poll_finished_bad_method.json', 'hitokotoPollFinished'],
  ['poll_finished_zero_status.json', 'hitokotoPollFinished'],
  ['moved_missing_operator.json', 'hitokotoMoved']
])

// channel → 它的 payload 应该指向哪个 schema 文件。
// 这一层是冗余的——上面的样本校验已经能抓住大部分错接——但改指到一个「碰巧也能通过」的
// schema 时只有这张表拦得住。
const expectedChannelSchemas = new Map([
  ['hitokotoAppended', 'hitokoto-appended.schema.json'],
  ['hitokotoReviewed', 'hitokoto-reviewed.schema.json'],
  ['hitokotoMoved', 'hitokoto-moved.schema.json'],
  ['hitokotoPollCreated', 'poll-created.schema.json'],
  ['hitokotoPollFinished', 'poll-finished.schema.json'],
  ['hitokotoPollDailyReport', 'poll-daily-report.schema.json'],
  ['notificationFailedCan', 'notification-failed-can.schema.json']
])

// 死信收集器收到的是原始业务消息，因此它的 payload 是这六个 schema 的 anyOf。
const collectorChannel = 'notificationFailedCollector'
const expectedCollectorSchemas = [
  'hitokoto-appended.schema.json',
  'hitokoto-reviewed.schema.json',
  'hitokoto-moved.schema.json',
  'poll-created.schema.json',
  'poll-finished.schema.json',
  'poll-daily-report.schema.json'
]

async function listJSONFiles(directory, recursive = false) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (recursive) files.push(...(await listJSONFiles(absolute, true)))
    } else if (entry.name.endsWith('.json')) {
      files.push(absolute)
    }
  }
  return files.sort()
}

const readJSON = async filename => JSON.parse(await fs.readFile(filename, 'utf8'))

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true })
addFormats(ajv)
// enum 的可读名字，供将来 codegen 生成常量名；对校验无影响。
ajv.addKeyword({ keyword: 'x-enumNames', schemaType: 'array', valid: true })

// schema 一律**不声明 `$id`**，跨文件 `$ref` 保持为相对文件路径。
//
// 原因：`asyncapi bundle` 会把 `$id` 当作解析相对 `$ref` 的 base URI，一旦 `$id` 是
// `https://…` 就会去下载那个地址而不是读磁盘上的兄弟文件，bundle 直接失败（而
// `asyncapi validate` 却会放行——validate 绿、bundle 红的陷阱）。
// 这里把每个 schema 注册在它自己的 `file://` URL 下，相对 `$ref` 于是解析到兄弟文件的
// 同名键上，与 bundler 的行为一致。
// enum 的取值在三处出现：schema 的 `enum`（机器校验）、`description` 里的 Markdown 表格
// （渲染进文档站）、`x-enumNames`（留给将来 codegen 生成常量名）。三处都靠人手维护，
// 这里把「不会漂移」变成可执行的断言。
function assertEnumNames(node, at, schemaFile) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertEnumNames(item, `${at}/${index}`, schemaFile))
    return
  }
  const names = node['x-enumNames']
  if (Array.isArray(names)) {
    const where = `${path.relative(repositoryRoot, schemaFile)}${at}`
    if (!Array.isArray(node.enum)) throw new Error(`${where}: 有 x-enumNames 却没有 enum`)
    if (names.length !== node.enum.length) {
      throw new Error(`${where}: x-enumNames 有 ${names.length} 项，enum 有 ${node.enum.length} 项，必须一一对应`)
    }
    for (const name of names) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`${where}: x-enumNames 的 "${name}" 不是合法标识符，将来无法用于 codegen`)
      }
    }
    const description = typeof node.description === 'string' ? node.description : ''
    for (const value of node.enum) {
      if (!description.includes('`' + String(value) + '`')) {
        throw new Error(`${where}: description 的表格里没有取值 \`${value}\`，文档已与 enum 漂移`)
      }
    }
  }
  for (const [key, value] of Object.entries(node)) assertEnumNames(value, `${at}/${key}`, schemaFile)
}

const schemaFiles = await listJSONFiles(schemasRoot, true)
for (const schemaFile of schemaFiles) {
  const schema = await readJSON(schemaFile)
  if ('$id' in schema) {
    throw new Error(
      `${path.relative(repositoryRoot, schemaFile)} 声明了 $id；` +
        '这会让 asyncapi bundle 把相对 $ref 解析成远程 URL。请删除 $id。'
    )
  }
  assertEnumNames(schema, '', schemaFile)
  ajv.addSchema(schema, pathToFileURL(schemaFile).href)
}

const schemaKey = schemaName => pathToFileURL(path.join(schemasRoot, schemaName)).href

function validatorFor(schemaName) {
  const validate = ajv.getSchema(schemaKey(schemaName))
  if (!validate) throw new Error(`schema 未注册：${schemaName}`)
  return validate
}

// ---- asyncapi.yaml 的接线 ----------------------------------------------------

const document = parseYAML(await fs.readFile(path.join(repositoryRoot, 'asyncapi.yaml'), 'utf8'))

function componentRef(ref, expectedPrefix) {
  if (typeof ref !== 'string' || !ref.startsWith(expectedPrefix)) {
    throw new Error(`期望形如 ${expectedPrefix}… 的 $ref，实际是 ${JSON.stringify(ref)}`)
  }
  return ref.slice(expectedPrefix.length)
}

// channel → payload $ref 指向的 schema 文件名（相对 schemas/）。
function resolveChannelPayload(channelID) {
  const channel = document.channels?.[channelID]
  if (!channel) throw new Error(`asyncapi.yaml 里没有 channel ${channelID}`)

  const messageRefs = Object.values(channel.messages ?? {})
  if (messageRefs.length !== 1) {
    throw new Error(`channel ${channelID} 应当恰好挂 1 条 message，实际 ${messageRefs.length} 条`)
  }

  const messageName = componentRef(messageRefs[0].$ref, '#/components/messages/')
  const message = document.components?.messages?.[messageName]
  if (!message) throw new Error(`channel ${channelID} 指向了不存在的 message ${messageName}`)

  const toSchemaName = ref => {
    const name = componentRef(ref, './schemas/')
    if (!schemaFiles.some(file => path.relative(schemasRoot, file).split(path.sep).join('/') === name)) {
      throw new Error(`message ${messageName} 指向了不存在的 schema ${name}`)
    }
    return name
  }

  if (Array.isArray(message.payload?.anyOf)) {
    return { anyOf: message.payload.anyOf.map(branch => toSchemaName(branch.$ref)) }
  }
  return { single: toSchemaName(message.payload?.$ref) }
}

// 每个 channel 都必须被恰好一个 operation 引用——多出来的 channel 是死代码，
// 少掉的 operation 意味着契约描述了一条没人消费的队列。
{
  const referenced = new Map()
  for (const [operationID, operation] of Object.entries(document.operations ?? {})) {
    const channelID = componentRef(operation.channel?.$ref, '#/channels/')
    if (!document.channels?.[channelID]) {
      throw new Error(`operation ${operationID} 引用了不存在的 channel ${channelID}`)
    }
    if (referenced.has(channelID)) {
      throw new Error(`channel ${channelID} 同时被 ${referenced.get(channelID)} 与 ${operationID} 引用`)
    }
    referenced.set(channelID, operationID)
  }
  for (const channelID of Object.keys(document.channels ?? {})) {
    if (!referenced.has(channelID)) throw new Error(`channel ${channelID} 没有任何 operation 引用它`)
  }
}

for (const [channelID, expected] of expectedChannelSchemas) {
  const resolved = resolveChannelPayload(channelID)
  if (resolved.single !== expected) {
    throw new Error(
      `channel ${channelID} 的 payload 应指向 ${expected}，实际指向 ${JSON.stringify(resolved)}`
    )
  }
}

{
  const resolved = resolveChannelPayload(collectorChannel)
  const actual = [...(resolved.anyOf ?? [])].sort()
  const wanted = [...expectedCollectorSchemas].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${collectorChannel} 的 anyOf 分支与预期不符。\n  实际：${actual.join(', ')}\n  预期：${wanted.join(', ')}`
    )
  }
}

// ---- 样本 --------------------------------------------------------------------

async function assertExampleSetMatches(directory, expected) {
  const actual = (await listJSONFiles(directory)).map(file => path.basename(file))
  const unregistered = actual.filter(name => !expected.has(name))
  const missing = [...expected.keys()].filter(name => !actual.includes(name))
  if (unregistered.length === 0 && missing.length === 0) return

  const lines = [`${path.relative(repositoryRoot, directory)} 的样本集合与接线表不一致：`]
  if (unregistered.length > 0) lines.push(`  + 磁盘上有、脚本未登记：${unregistered.join(', ')}`)
  if (missing.length > 0) lines.push(`  - 脚本已登记、磁盘上没有：${missing.join(', ')}`)
  lines.push('')
  lines.push('修复方式（两处都要改，漏一处 CI 就会红）：')
  lines.push('  1. 本文件的 positiveExamples / negativeExamples')
  lines.push('  2. 消费侧 consumers/notification/v1/contracts_regression_test.go 的')
  lines.push('     contractExampleValidators / contractInvalidExampleValidators')
  throw new Error(lines.join('\n'))
}

await assertExampleSetMatches(examplesRoot, positiveExamples)
await assertExampleSetMatches(path.join(examplesRoot, 'invalid'), negativeExamples)

for (const [exampleName, channelID] of positiveExamples) {
  const validate = validatorFor(resolveChannelPayload(channelID).single)
  if (!validate(await readJSON(path.join(examplesRoot, exampleName)))) {
    throw new Error(`${exampleName} 必须通过 ${channelID} 的 payload：${ajv.errorsText(validate.errors)}`)
  }
}

for (const [exampleName, channelID] of negativeExamples) {
  const validate = validatorFor(resolveChannelPayload(channelID).single)
  if (validate(await readJSON(path.join(examplesRoot, 'invalid', exampleName)))) {
    throw new Error(`${exampleName} 本应被 ${channelID} 的 payload 拒绝，却通过了`)
  }
}

// 死信收集器的 anyOf 必须真的能接住六条业务消息。
// 用 anyOf 而非 oneOf：底座宽松，moved / reviewed 的消息同时也满足 appended 的 schema，
// oneOf 会因「匹配了多个分支」而误判失败——这一段就是那个判断的可执行证据。
{
  const validateCollector = ajv.compile({
    anyOf: resolveChannelPayload(collectorChannel).anyOf.map(name => ({ $ref: schemaKey(name) }))
  })
  for (const [exampleName, channelID] of positiveExamples) {
    if (channelID === 'notificationFailedCan') continue // 包装体不会经过收集器
    if (!validateCollector(await readJSON(path.join(examplesRoot, exampleName)))) {
      throw new Error(
        `${exampleName} 必须能被死信收集器的 anyOf 接住：${ajv.errorsText(validateCollector.errors)}`
      )
    }
  }
}

console.log(
  `已校验 ${schemaFiles.length} 个 schema、${positiveExamples.size} 个正样本、` +
    `${negativeExamples.size} 个负样本，以及 asyncapi.yaml 的 channel→message→schema 接线。`
)
