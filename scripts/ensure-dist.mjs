// `asyncapi bundle` 不会创建 --output 的父目录，dist/ 缺失时直接 ENOENT 失败。
// dist/ 又在 .gitignore 里，无法用 .gitkeep 兜住，只能每次 bundle 前建一次。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
fs.mkdirSync(path.join(repositoryRoot, 'dist'), { recursive: true })
