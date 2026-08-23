// payload 向后兼容性的兜底断言。
//
// 为什么不能只靠 `asyncapi diff --type breaking`：实测它对 payload schema 的改动一律归为
// unclassified。往 hitokoto-base 的 required 里加一个字段——对四个生产者而言是彻头彻尾的
// 破坏性变更——diff 返回 `[]` 并以 0 退出。它真正拦得住的只有 channel.address 这类结构层改动。
//
// 判定原则：**契约可以随意放宽，任何收紧或信息丢失都必须过人工。**
//
//   收紧（拦，需 breaking-change + MAJOR）   放宽（放行）
//   required 新增条目                        required 去掉条目
//   enum 删除取值                            enum 增加取值 / 整体去掉 enum
//   properties 删除字段                      properties 新增字段
//   type 不再接受某个形态                     type 多接受一个形态
//   新增或改动约束关键字                      删除约束关键字
//   allOf 新增分支                           allOf 去掉分支
//   anyOf / oneOf 去掉分支                   anyOf / oneOf 新增分支
//   删除 schema 文件                         新增 schema 文件
//
// 还有第三类：同一个节点上**既加了新约束、又删了旧约束**。这多半是等价改写
// （`minimum: 1` 换成 `not: {const: 0}`），方向无法自动判定，归为「需人工确认」，
// 用 `compat-reviewed` 标签放行且不要求升 MAJOR。把它硬算成收紧会逼着一次纯放宽升 MAJOR。
//
// allOf / anyOf / oneOf 一律按**无序分支集合**比对，不按下标。按下标比会让「往数组中间插一个
// 分支」把后面每一项都算成改动，也会让纯粹的重排产生假阳性。
//
// 用法：node scripts/check-payload-compat.mjs BASELINE_SCHEMAS_DIR CANDIDATE_SCHEMAS_DIR

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [baselineDir, candidateDir] = process.argv.slice(2)
if (!baselineDir || !candidateDir) {
  throw new Error('用法：node scripts/check-payload-compat.mjs BASELINE_SCHEMAS_DIR CANDIDATE_SCHEMAS_DIR')
}

// 纯文档字段，改动不影响任何生产者。
const DOC_KEYWORDS = new Set(['description', 'title', 'examples', 'default', '$comment', '$schema'])

// 约束关键字：值发生任何变化都要过人工——放宽还是收紧无法可靠判定，
// 而这些关键字在本仓极少改动，宁可多问一次。
const CONSTRAINT_KEYWORDS = [
  '$ref',
  'pattern',
  'format',
  'const',
  'not',
  'multipleOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'additionalProperties',
  'additionalItems',
  'propertyNames',
  'dependencies'
]

// 稳定序列化：键排序，这样「只是重新缩进 / 调换键顺序」不会被当成改动。
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return (
    '{' +
    Object.keys(value)
      .filter(key => !DOC_KEYWORDS.has(key))
      .sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  )
}

async function listSchemas(directory) {
  const found = new Map()
  // 刻意不吞异常：读不到目录时必须炸，不能退化成「baseline 为空所以放行」。
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.name.endsWith('.schema.json')) {
        const key = path.relative(directory, absolute).split(path.sep).join('/')
        found.set(key, JSON.parse(await fs.readFile(absolute, 'utf8')))
      }
    }
  }
  await walk(directory)
  return found
}

function compareBranches(keyword, before, after, at, out) {
  const beforeSet = new Map(before.map(branch => [canonical(branch), branch]))
  const afterSet = new Map(after.map(branch => [canonical(branch), branch]))

  if (keyword === 'allOf') {
    // allOf 是合取：多一个分支就是多一条必须同时满足的约束。
    for (const [key, branch] of afterSet) {
      if (!beforeSet.has(key)) out.tightening.push(`${at}.allOf 新增分支：${canonical(branch).slice(0, 160)}`)
    }
    return
  }
  // anyOf / oneOf 是析取：少一个分支就是少接受一类消息。
  for (const [key, branch] of beforeSet) {
    if (!afterSet.has(key)) out.tightening.push(`${at}.${keyword} 删除分支：${canonical(branch).slice(0, 160)}`)
  }
}

function compareNode(before, after, at, out) {
  if (before === null || typeof before !== 'object' || Array.isArray(before)) return
  if (after === null || typeof after !== 'object' || Array.isArray(after)) {
    out.tightening.push(`${at}：从 schema 对象变成了 ${JSON.stringify(after)}`)
    return
  }

  const beforeRequired = new Set(Array.isArray(before.required) ? before.required : [])
  for (const name of Array.isArray(after.required) ? after.required : []) {
    if (!beforeRequired.has(name)) out.tightening.push(`${at}：required 新增 "${name}"`)
  }

  // 整体删掉 enum 是放宽（此后任何取值都接受），按上面的原则放行；
  // 只有删掉个别取值才是收紧。
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const afterEnum = new Set(after.enum.map(canonical))
    for (const value of before.enum) {
      if (!afterEnum.has(canonical(value))) out.tightening.push(`${at}：enum 删除取值 ${canonical(value)}`)
    }
  }

  // type 按集合比：`"object"` → `["object","null"]` 是多接受一种形态，属于放宽。
  // 只有「原来接受、现在不接受」的那部分才是收紧。
  if ('type' in before) {
    const beforeTypes = new Set(Array.isArray(before.type) ? before.type : [before.type])
    const afterTypes = new Set(
      'type' in after ? (Array.isArray(after.type) ? after.type : [after.type]) : []
    )
    if (afterTypes.size > 0) {
      const narrowed = [...beforeTypes].filter(name => !afterTypes.has(name))
      if (narrowed.length > 0) {
        out.tightening.push(`${at}：type 不再接受 ${narrowed.map(n => JSON.stringify(n)).join(' / ')}`)
      }
    }
  }

  // 约束关键字：单看某一个关键字无法判断方向。但如果同一个节点上**既加了新约束、
  // 又删了旧约束**，多半是等价改写或放宽（比如 `minimum: 1` 换成 `not: {const: 0}`），
  // 硬判成收紧会逼着一次纯放宽去升 MAJOR。这类情况单独归为「需人工确认」。
  const added = []
  const changed = []
  const removed = []
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const had = keyword in before
    const has = keyword in after
    if (had && !has) removed.push(keyword)
    else if (!had && has) added.push(`${keyword} = ${canonical(after[keyword]).slice(0, 120)}`)
    else if (had && has && canonical(before[keyword]) !== canonical(after[keyword])) {
      changed.push(
        `${keyword} ${canonical(before[keyword]).slice(0, 80)} → ${canonical(after[keyword]).slice(0, 80)}`
      )
    }
  }
  const bucket = removed.length > 0 && (added.length > 0 || changed.length > 0) ? out.ambiguous : out.tightening
  for (const entry of added) bucket.push(`${at}：新增约束 ${entry}`)
  for (const entry of changed) bucket.push(`${at}：约束 ${entry}`)
  if (bucket === out.ambiguous && removed.length > 0) {
    bucket.push(`${at}：同时删除了约束 ${removed.join(' / ')}`)
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(before[keyword]) && !Array.isArray(after[keyword])) continue
    compareBranches(keyword, before[keyword] ?? [], after[keyword] ?? [], at, out)
  }

  if (before.properties && typeof before.properties === 'object') {
    const afterProperties = (after.properties && typeof after.properties === 'object') ? after.properties : {}
    for (const [name, schema] of Object.entries(before.properties)) {
      if (!(name in afterProperties)) {
        out.tightening.push(`${at}：删除了字段 "${name}"`)
        continue
      }
      compareNode(schema, afterProperties[name], `${at}.${name}`, out)
    }
  }

  for (const keyword of ['items', 'definitions', '$defs']) {
    if (before[keyword] && typeof before[keyword] === 'object' && !Array.isArray(before[keyword])) {
      compareNode(before[keyword], after[keyword], `${at}.${keyword}`, out)
    }
  }
}

const baseline = await listSchemas(baselineDir)
const candidate = await listSchemas(candidateDir)

// fail closed：目录空掉多半意味着路径写错或 checkout 出了问题，不能当成「没有变更」。
if (baseline.size === 0) throw new Error(`${baselineDir} 下没有任何 *.schema.json`)
if (candidate.size === 0) throw new Error(`${candidateDir} 下没有任何 *.schema.json`)

const findings = { tightening: [], ambiguous: [] }
for (const [file, beforeSchema] of baseline) {
  const afterSchema = candidate.get(file)
  if (!afterSchema) {
    findings.tightening.push(`删除了 schema 文件 ${file}`)
    continue
  }
  compareNode(beforeSchema, afterSchema, file, findings)
}

const tightening = [...new Set(findings.tightening)]
const ambiguous = [...new Set(findings.ambiguous)]

if (tightening.length > 0) {
  console.error('检测到 payload 收紧：')
  for (const line of tightening) console.error('  - ' + line)
  console.error('')
  console.error('这类改动会让四个生产方现有的合规流量瞬间变成不合规。')
  console.error('确属有意为之时，给 PR 打上 `breaking-change` 标签，')
  console.error('并在同一个 PR 里升 MAJOR 版本、更新 CHANGELOG 与生产方迁移说明。')
}

if (ambiguous.length > 0) {
  if (tightening.length > 0) console.error('')
  console.error('以下节点上的约束被替换了，方向无法自动判定，需要人工确认：')
  for (const line of ambiguous) console.error('  - ' + line)
  console.error('')
  console.error('如果确认是等价改写或放宽（例如 `minimum: 1` 换成 `not: {const: 0}`），')
  console.error('给 PR 打上 `compat-reviewed` 标签即可放行——**不需要**升 MAJOR。')
  console.error('如果其实是收紧，请改用 `breaking-change` 标签并升 MAJOR。')
}

if (tightening.length > 0 || ambiguous.length > 0) {
  process.exitCode = 1
} else {
  console.log(`payload 未出现收紧（比对了 ${baseline.size} 个 schema）。`)
}
