// 保证 asyncapi.yaml 的 info.version、package.json 的 version 与 git tag 三者一致。
//
// 契约的版本号是消费方判断"我拿到的是哪一版"的唯一依据，三处漂移会让 SemVer 承诺失效。

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const asyncapi = parse(await fs.readFile(path.join(repositoryRoot, 'asyncapi.yaml'), 'utf8'))
const packageJSON = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))

const contractVersion = asyncapi?.info?.version
if (typeof contractVersion !== 'string' || contractVersion.length === 0) {
  throw new Error('asyncapi.yaml 必须定义 info.version')
}

if (packageJSON.version !== contractVersion) {
  throw new Error(
    `package.json 的 version (${packageJSON.version}) 与 asyncapi.yaml 的 info.version (${contractVersion}) 不一致`
  )
}

// tag 来源：CI 里由 GITHUB_REF_* 提供；本地可用 --tag=v1.2.3 手动核对。
const tagName =
  process.env.GITHUB_REF_TYPE === 'tag'
    ? process.env.GITHUB_REF_NAME
    : process.argv.find(argument => argument.startsWith('--tag='))?.slice('--tag='.length)

if (tagName) {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tagName)) {
    throw new Error(`发布 tag 必须形如 vMAJOR.MINOR.PATCH：${tagName}`)
  }
  if (tagName.slice(1) !== contractVersion) {
    throw new Error(`git tag ${tagName} 与 info.version ${contractVersion} 不一致`)
  }
}

console.log(`契约版本 ${contractVersion} 一致${tagName ? `（含 tag ${tagName}）` : ''}。`)
