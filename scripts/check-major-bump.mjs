// 打了 `topology-change` / `breaking-change` 标签的 PR，必须真的升 MAJOR。
//
// 没有这一步，标签就只是「关掉门禁」的开关：一个破坏性改动可以贴着标签、停在 1.1.0 合进来，
// 下游四个生产者看不到任何版本信号。
//
// 用法：node scripts/check-major-bump.mjs BASELINE_ASYNCAPI CANDIDATE_ASYNCAPI

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { parse } from 'yaml'

const [baselineFile, candidateFile] = process.argv.slice(2)
if (!baselineFile || !candidateFile) {
  throw new Error('用法：node scripts/check-major-bump.mjs BASELINE_ASYNCAPI CANDIDATE_ASYNCAPI')
}

async function versionOf(filename) {
  const document = parse(await fs.readFile(path.resolve(filename), 'utf8'))
  const version = document?.info?.version
  if (typeof version !== 'string') throw new Error(`${filename} 缺少 info.version`)
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`${filename} 的 info.version 不是 MAJOR.MINOR.PATCH：${version}`)
  return { raw: version, major: Number(match[1]) }
}

const baseline = await versionOf(baselineFile)
const candidate = await versionOf(candidateFile)

if (candidate.major <= baseline.major) {
  console.error(`本 PR 带着破坏性变更标签，但 MAJOR 没有递增：${baseline.raw} → ${candidate.raw}`)
  console.error('')
  console.error('标签的作用是「我知道这是破坏性变更」，不是「跳过版本纪律」。')
  console.error(`请把 asyncapi.yaml 的 info.version 与 package.json 的 version 一并升到 ${baseline.major + 1}.0.0，`)
  console.error('并在 CHANGELOG 里写明四语言生产者的迁移步骤。')
  process.exitCode = 1
} else {
  console.log(`破坏性变更已伴随 MAJOR 递增：${baseline.raw} → ${candidate.raw}。`)
}
