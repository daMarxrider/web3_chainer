#!/usr/bin/env node
// Lines of the GUI's source that no browser test ran.
//   GUI_COV_FILE=/tmp/gui.cov node --test apps/gui/test/browser/*.test.ts
//   node scripts/gui-coverage.mjs /tmp/gui.cov
// Each record holds V8 ranges for one module as Vite served it; the module is transformed again here
// with Vite (same config) to get the code and its source map, which maps covered bytes to .ts lines.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../apps/gui/', import.meta.url))
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function decode(mappings) {
  // Returns, per generated line, a list of [generatedColumn, sourceIndex, originalLine].
  const lines = []
  let src = 0, oLine = 0, oCol = 0
  for (const line of mappings.split(';')) {
    let gCol = 0
    const segs = []
    for (const seg of line.split(',').filter(Boolean)) {
      const vals = []
      let v = 0, shift = 0
      for (const ch of seg) {
        const d = B64.indexOf(ch)
        v += (d & 31) << shift
        if (d & 32) shift += 5
        else { vals.push(v & 1 ? -(v >> 1) : v >> 1); v = 0; shift = 0 }
      }
      gCol += vals[0]
      if (vals.length >= 4) { src += vals[1]; oLine += vals[2]; oCol += vals[3]; segs.push([gCol, src, oLine]) }
    }
    lines.push(segs)
  }
  return lines
}

const records = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byPath = new Map()
for (const r of records) (byPath.get(r.path) ?? byPath.set(r.path, []).get(r.path)).push(r.ranges)
const vite = await createServer({ root, configFile: `${root}vite.config.ts`, logLevel: 'silent', server: { middlewareMode: true } })
for (const [path, runs] of [...byPath].sort()) {
  if (!path.endsWith('.ts')) continue
  const result = await vite.transformRequest(path)
  const code = result.code
  const hit = new Uint8Array(code.length)
  for (const ranges of runs) {
    const count = new Int32Array(code.length)
    for (const r of [...ranges].sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset))) count.fill(r.count, r.startOffset, Math.min(r.endOffset, code.length))
    for (let i = 0; i < code.length; i++) if (count[i] > 0) hit[i] = 1
  }
  const map = decode(result.map.mappings)
  const srcLines = readFileSync(`${root}${path.slice(1)}`, 'utf8').split('\n')
  const ran = new Set(), mapped = new Set()
  let offset = 0
  code.split('\n').forEach((line, g) => {
    for (const [col, , oLine] of map[g] ?? []) {
      mapped.add(oLine)
      if (hit[offset + col]) ran.add(oLine)
    }
    offset += line.length + 1
  })
  const missed = [...mapped].filter((l) => !ran.has(l) && srcLines[l]?.trim() && !/^(\/\/|\*|\/\*|[{}()[\];,]+$)/.test(srcLines[l].trim())).sort((a, b) => a - b).map((l) => l + 1)
  console.log(`${path}: ${missed.length} lines never run${missed.length ? `: ${missed.join(' ')}` : ''}`)
}
await vite.close()
process.exit(0)
