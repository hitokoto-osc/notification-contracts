// 校验 examples/ 与 schemas/ 是否自洽。
//
// 两个方向都要跑：
//   examples/         → 必须通过对应 schema
//   examples/invalid/ → 必须被对应 schema 拒绝
// 只有正样本会让"放宽了约束但样本仍全绿"的改动悄悄溜过去。

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemasRoot = path.join(repositoryRoot, 'schemas')
const examplesRoot = path.join(repositoryRoot, 'examples')

const positiveExamples = new Map([
  ['hitokoto_appended.json', 'hitokoto-appended.schema.json'],
  ['hitokoto_reviewed.json', 'hitokoto-reviewed.schema.json'],
  ['hitokoto_moved.json', 'hitokoto-moved.schema.json'],
  ['hitokoto_poll_created.json', 'poll-created.schema.json'],
  ['hitokoto_poll_finished.json', 'poll-finished.schema.json'],
  ['hitokoto_poll_daily_report.json', 'poll-daily-report.schema.json'],
  ['notification_failed_can.json', 'notification-failed-can.schema.json']
])

const negativeExamples = new Map([
  ['appended_bad_uuid.json', 'hitokoto-appended.schema.json'],
  ['appended_bad_type.json', 'hitokoto-appended.schema.json'],
  ['appended_bad_timestamp_length.json', 'hitokoto-appended.schema.json'],
  ['poll_finished_bad_method.json', 'poll-finished.schema.json'],
  ['poll_finished_zero_status.json', 'poll-finished.schema.json'],
  ['moved_missing_operator.json', 'hitokoto-moved.schema.json']
])

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

async function readJSON(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'))
}

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: true })
addFormats(ajv)
// enum 的可读名字，供将来 codegen 生成常量名；对校验无影响。
ajv.addKeyword({ keyword: 'x-enumNames', schemaType: 'array', valid: true })

// schema 一律**不声明 `$id`**，跨文件 `$ref` 保持为相对文件路径。
//
// 原因：`asyncapi bundle` 会把 `$id` 当作解析相对 `$ref` 的 base URI，一旦
// `$id` 是 `https://…` 就会去下载那个地址而不是读磁盘上的兄弟文件，bundle 直接失败
// （而 `asyncapi validate` 却会放行——validate 绿、bundle 红的陷阱）。
// 这里把每个 schema 注册在它自己的 `file://` URL 下，相对 `$ref` 于是解析到
// 兄弟文件的同名键上，与 bundler 的行为一致。
const schemaFiles = await listJSONFiles(schemasRoot, true)
for (const schemaFile of schemaFiles) {
  const schema = await readJSON(schemaFile)
  if ('$id' in schema) {
    throw new Error(
      `${path.relative(repositoryRoot, schemaFile)} 声明了 $id；` +
        '这会让 asyncapi bundle 把相对 $ref 解析成远程 URL。请删除 $id。'
    )
  }
  ajv.addSchema(schema, pathToFileURL(schemaFile).href)
}

function validatorFor(schemaName) {
  const validate = ajv.getSchema(pathToFileURL(path.join(schemasRoot, schemaName)).href)
  if (!validate) throw new Error(`schema 未注册：${schemaName}`)
  return validate
}

async function assertExampleSetMatches(directory, expected) {
  const actual = (await listJSONFiles(directory)).map(file => path.basename(file))
  const wanted = [...expected.keys()].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(
      `${path.relative(repositoryRoot, directory)} 的样本集合与接线表不一致。\n` +
        `  磁盘上：[${actual.join(', ')}]\n` +
        `  接线表：[${wanted.join(', ')}]\n` +
        '新增样本必须同时登记到本脚本与 Go 侧的回归测试。'
    )
  }
}

await assertExampleSetMatches(examplesRoot, positiveExamples)
await assertExampleSetMatches(path.join(examplesRoot, 'invalid'), negativeExamples)

for (const [exampleName, schemaName] of positiveExamples) {
  const validate = validatorFor(schemaName)
  if (!validate(await readJSON(path.join(examplesRoot, exampleName)))) {
    throw new Error(`${exampleName} 必须通过 ${schemaName}：${ajv.errorsText(validate.errors)}`)
  }
}

for (const [exampleName, schemaName] of negativeExamples) {
  const validate = validatorFor(schemaName)
  if (validate(await readJSON(path.join(examplesRoot, 'invalid', exampleName)))) {
    throw new Error(`${exampleName} 本应被 ${schemaName} 拒绝，却通过了`)
  }
}

console.log(
  `已校验 ${schemaFiles.length} 个 schema、${positiveExamples.size} 个正样本、${negativeExamples.size} 个负样本。`
)
