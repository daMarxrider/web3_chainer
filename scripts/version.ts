#!/usr/bin/env node
// One version for the whole app. The root package.json holds it; every other file follows.
//
//   node scripts/version.ts check            all files agree (also run by the tests)
//   node scripts/version.ts bump <kind>      kind: patch (bug fix), minor (new feature),
//                                            major (breaks backwards compatibility), or X.Y.Z
//   node scripts/version.ts tag              on an up-to-date, clean main: tag vX.Y.Z locally
//
// The rules are in the README under "Versions".
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKSPACES = ['packages/core', 'apps/cli', 'apps/gui']
const TAURI_CONF = 'apps/gui/src-tauri/tauri.conf.json'
const CARGO_TOML = 'apps/gui/src-tauri/Cargo.toml'
const CARGO_LOCK = 'apps/gui/src-tauri/Cargo.lock'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export type Bump = 'patch' | 'minor' | 'major'

export function nextVersion(current: string, kind: Bump | string): string {
  const m = SEMVER.exec(current)
  if (!m) throw new Error(`"${current}" is not a MAJOR.MINOR.PATCH version`)
  const [major, minor, patch] = m.slice(1).map(Number) as [number, number, number]
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'major') return `${major + 1}.0.0`
  if (!SEMVER.test(kind)) throw new Error(`Unknown bump "${kind}": use patch, minor, major or X.Y.Z`)
  const order = (v: string) => v.split('.').map(Number) as [number, number, number]
  const [a, b] = [order(kind), order(current)]
  if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2])))) {
    throw new Error(`${kind} is not above the current version ${current}`)
  }
  return kind
}

const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8')
const json = (root: string, file: string) => JSON.parse(read(root, file))
// The crate's own entry: `name = "chainer"` followed by its version line.
const CARGO_LOCK_ENTRY = /(\[\[package\]\]\nname = "chainer"\nversion = ")([^"]+)(")/
const CARGO_TOML_VERSION = /^(\[package\][\s\S]*?\nversion = ")([^"]+)(")/

/** Every place that carries the version, with what it says now. */
export function versions(root = ROOT): Record<string, string | undefined> {
  const lock = json(root, 'package-lock.json')
  const found: Record<string, string | undefined> = { 'package.json': json(root, 'package.json').version }
  for (const ws of WORKSPACES) {
    found[`${ws}/package.json`] = json(root, `${ws}/package.json`).version
    found[`package-lock.json (${ws})`] = lock.packages[ws]?.version
  }
  found['package-lock.json (root)'] = lock.version
  found[TAURI_CONF] = json(root, TAURI_CONF).version
  found[CARGO_TOML] = CARGO_TOML_VERSION.exec(read(root, CARGO_TOML))?.[2]
  found[CARGO_LOCK] = CARGO_LOCK_ENTRY.exec(read(root, CARGO_LOCK))?.[2]
  return found
}

/** The files that disagree with the root package.json. */
export function mismatches(root = ROOT): string[] {
  const all = versions(root)
  const want = all['package.json']
  return Object.entries(all)
    .filter(([, v]) => v !== want)
    .map(([file, v]) => `${file}: ${v ?? 'missing'} (want ${want})`)
}

// Top-level "version" of a JSON file, changed in place so the file keeps its layout.
const JSON_VERSION = /^(  "version": ")([^"]+)(")/m

export function setVersion(version: string, root = ROOT): void {
  const files: [string, RegExp][] = [
    ['package.json', JSON_VERSION],
    ...WORKSPACES.map((ws): [string, RegExp] => [`${ws}/package.json`, JSON_VERSION]),
    [TAURI_CONF, JSON_VERSION],
    [CARGO_TOML, CARGO_TOML_VERSION],
    [CARGO_LOCK, CARGO_LOCK_ENTRY],
  ]
  for (const [file, re] of files) {
    const text = read(root, file)
    if (!re.test(text)) throw new Error(`No version found in ${file}`)
    writeFileSync(join(root, file), text.replace(re, `$1${version}$3`))
  }
  // npm writes the lock file's copies itself.
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' })
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

function tag(): string {
  const bad = mismatches()
  if (bad.length) throw new Error(`Versions disagree, run "check":\n${bad.join('\n')}`)
  if (git('branch', '--show-current') !== 'main') throw new Error('Tag releases from main only')
  if (git('status', '--porcelain')) throw new Error('The working tree is not clean')
  git('fetch', '--quiet', 'origin', 'main')
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('main is not the same as origin/main; pull or push first')
  const name = `v${json(ROOT, 'package.json').version}`
  git('tag', '-a', name, '-m', `chainer ${name}`)
  return name
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  try {
    if (cmd === 'check') {
      const bad = mismatches()
      if (bad.length) throw new Error(`Versions disagree:\n${bad.join('\n')}`)
      console.log(`All files at ${json(ROOT, 'package.json').version}`)
    } else if (cmd === 'bump' && arg) {
      const from = json(ROOT, 'package.json').version
      const to = nextVersion(from, arg)
      setVersion(to)
      console.log(`${from} -> ${to}. Commit this on a branch and merge it, then run "npm run version:tag" on main.`)
    } else if (cmd === 'tag') {
      const name = tag()
      console.log(`Tagged ${name}. Push it to start the release builds: git push origin ${name}`)
    } else {
      throw new Error('Usage: node scripts/version.ts check | bump <patch|minor|major|X.Y.Z> | tag')
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
