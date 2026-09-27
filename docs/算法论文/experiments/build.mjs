// 用 esbuild 把 run.ts 打包成单文件再运行，结果写到本目录的 results.json
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
const here = dirname(fileURLToPath(import.meta.url))
const out = join(tmpdir(), 'lookask-paper-experiments.mjs')
execFileSync(join(here, '../../../node_modules/.bin/esbuild'), [join(here, 'run.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`], { stdio: 'inherit' })
execFileSync('node', [out, join(here, 'results.json')], { stdio: 'inherit' })
