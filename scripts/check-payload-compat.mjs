// payload 向后兼容性的兜底断言。
//
// 为什么不能只靠 `asyncapi diff --type breaking`：实测它对 payload schema 的改动
// 一律归为 unclassified。往 hitokoto-base 的 required 里加一个字段——对四个生产者
// 而言是彻头彻尾的破坏性变更——diff 返回 `[]` 并以 0 退出。
// 它真正拦得住的只有 channel.address 这类结构层改动。
//
// 本脚本直接比对两个 revision 的 schemas/ 目录，判定这几类破坏性收紧：
//   - 删除 schema 文件
//   - required 新增条目
//   - enum 删除取值
//   - properties 删除字段
//   - type 变更
// 反向的放宽（去掉 required、增加 enum 取值、新增可选字段）一律放行。
//
// 用法：node scripts/check-payload-compat.mjs BASELINE_SCHEMAS_DIR CANDIDATE_SCHEMAS_DIR

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const [baselineDir, candidateDir] = process.argv.slice(2)
if (!baselineDir || !candidateDir) {
  throw new Error('用法：node scripts/check-payload-compat.mjs BASELINE_SCHEMAS_DIR CANDIDATE_SCHEMAS_DIR')
}

async function listSchemas(directory) {
  const found = new Map()
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
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

// 把一份 schema 压成 pointer → 约束 的平表，nested 的 required / enum 一并覆盖。
function flatten(node, pointer = '', out = { required: new Map(), enum: new Map(), properties: new Map(), type: new Map() }) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => flatten(item, `${pointer}/${index}`, out))
    return out
  }
  if (node === null || typeof node !== 'object') return out

  if (Array.isArray(node.required)) out.required.set(pointer, new Set(node.required))
  if (Array.isArray(node.enum)) out.enum.set(pointer, new Set(node.enum.map(value => JSON.stringify(value))))
  if (node.properties && typeof node.properties === 'object') {
    out.properties.set(pointer, new Set(Object.keys(node.properties)))
  }
  if ('type' in node) out.type.set(pointer, JSON.stringify(node.type))

  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' || key === 'examples' || key === 'title') continue
    flatten(value, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, out)
  }
  return out
}

const baseline = await listSchemas(baselineDir)
const candidate = await listSchemas(candidateDir)

if (baseline.size === 0) {
  console.log('baseline 没有 schemas/，跳过 payload 兼容性比对。')
  process.exit(0)
}

const breaking = []

for (const [file, baselineSchema] of baseline) {
  const candidateSchema = candidate.get(file)
  if (!candidateSchema) {
    breaking.push(`- 删除了 schema 文件 ${file}`)
    continue
  }

  const before = flatten(baselineSchema)
  const after = flatten(candidateSchema)

  for (const [pointer, values] of before.required) {
    const now = after.required.get(pointer) ?? new Set()
    for (const name of now) {
      if (!values.has(name)) breaking.push(`~ ${file}${pointer || '/'}: required 新增了 "${name}"`)
    }
  }
  // baseline 里没有 required 而 candidate 新加了整个 required 数组，同样是收紧
  for (const [pointer, now] of after.required) {
    if (before.required.has(pointer)) continue
    for (const name of now) breaking.push(`~ ${file}${pointer || '/'}: 新增 required "${name}"`)
  }

  for (const [pointer, values] of before.enum) {
    const now = after.enum.get(pointer)
    if (!now) {
      breaking.push(`~ ${file}${pointer}: 删除了 enum 约束`)
      continue
    }
    for (const value of values) {
      if (!now.has(value)) breaking.push(`~ ${file}${pointer}: enum 删除了取值 ${value}`)
    }
  }

  for (const [pointer, names] of before.properties) {
    const now = after.properties.get(pointer) ?? new Set()
    for (const name of names) {
      if (!now.has(name)) breaking.push(`~ ${file}${pointer}: 删除了字段 "${name}"`)
    }
  }

  for (const [pointer, value] of before.type) {
    const now = after.type.get(pointer)
    if (now !== undefined && now !== value) {
      breaking.push(`~ ${file}${pointer}: type ${value} → ${now}`)
    }
  }
}

if (breaking.length > 0) {
  console.error('检测到 payload 的破坏性收紧：')
  for (const line of [...new Set(breaking)]) console.error('  ' + line)
  console.error('')
  console.error('这类改动会让四个生产者现有的合规流量瞬间变成不合规。')
  console.error('确属有意变更时，给 PR 打上 `breaking-change` 标签以跳过本检查，')
  console.error('并在同一个 PR 里升 MAJOR 版本、更新 CHANGELOG 与生产者迁移说明。')
  process.exitCode = 1
} else {
  console.log(`payload 未出现破坏性收紧（比对了 ${baseline.size} 个 schema）。`)
}
