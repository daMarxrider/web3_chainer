#!/usr/bin/env node
// Builds the command line as one executable for the system this runs on (Node.js single
// executable application), packed with the licence notices it needs:
//
//   node scripts/build-cli.ts        -> apps/cli/dist/chainer-<version>-<os>-<arch>.tar.gz (.zip on Windows)
//
// Needs Node.js 25.5 or later (node --build-sea). The optional SDK sources (Atomiq) are not
// inside: the binary can only load Node's own modules, so they show as not installed.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'apps/cli/dist')
const [major, minor] = process.versions.node.split('.').map(Number) as [number, number]
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`Node.js ${process.versions.node} cannot build single executables; use 25.5 or later.`)
  process.exit(1)
}

const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const os = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform as string] ?? process.platform
const name = `chainer-${version}-${os}-${process.arch}`
const work = join(DIST, name)
const exe = join(work, process.platform === 'win32' ? 'chainer.exe' : 'chainer')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// 1. One ES module with every dependency inside. Bundled CommonJS packages that call require()
//    get a real one (only Node's own modules resolve inside the binary).
const bundle = join(work, 'chainer.mjs')
const { metafile } = await build({
  entryPoints: [join(ROOT, 'apps/cli/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: bundle,
  metafile: true,
  legalComments: 'none', // the full licence texts go into THIRD-PARTY-NOTICES.txt below
  banner: { js: "import { createRequire as __chainerRequire } from 'node:module'; const require = __chainerRequire(import.meta.url);" },
  logLevel: 'warning',
})

// 2. The executable.
const seaConfig = join(work, 'sea.json')
writeFileSync(seaConfig, JSON.stringify({ main: bundle, mainFormat: 'module', output: exe, disableExperimentalSEAWarning: true, useCodeCache: false }))
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' })
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' }) // macOS refuses to start it unsigned
rmSync(bundle)
rmSync(seaConfig)

// 3. Licences: the app's own (GPL), Node.js's (it is the runtime inside), and every bundled package's.
function packageRoot(file: string): string | undefined {
  const at = file.lastIndexOf('node_modules/')
  if (at < 0) return undefined
  const rest = file.slice(at + 'node_modules/'.length).split('/')
  return file.slice(0, at + 'node_modules/'.length) + rest.slice(0, rest[0]!.startsWith('@') ? 2 : 1).join('/')
}
const packages = [...new Set(Object.keys(metafile.inputs).map(packageRoot).filter((p): p is string => !!p))].sort()
const seen = new Set<string>()
const notices = packages.flatMap((dir) => {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
  if (seen.has(`${pkg.name}@${pkg.version}`)) return [] // the same release nested twice
  seen.add(`${pkg.name}@${pkg.version}`)
  const file = readdirSync(join(ROOT, dir)).find((f) => /^(licen[cs]e|copying)/i.test(f))
  // Some packages declare a standard licence but leave its text out of the npm package.
  const text = file ? join(ROOT, dir, file) : join(ROOT, 'scripts/licenses', `${pkg.license}.txt`)
  if (!existsSync(text)) throw new Error(`${pkg.name} has no licence file and ${pkg.license} has no text in scripts/licenses; check its terms before shipping it`)
  return `${pkg.name} ${pkg.version} (${pkg.license})\n${'='.repeat(72)}\n${readFileSync(text, 'utf8').trim()}\n`
})
writeFileSync(join(work, 'THIRD-PARTY-NOTICES.txt'), `chainer ${version} contains the following packages.\n\n${notices.join('\n\n')}`)
const nodeLicence = [join(dirname(process.execPath), '..', 'LICENSE'), join(dirname(process.execPath), 'LICENSE'), '/usr/share/licenses/nodejs/LICENSE'].find(existsSync)
if (!nodeLicence) throw new Error('Node.js LICENSE file not found next to the node executable')
copyFileSync(nodeLicence, join(work, 'NODE-LICENSE.txt'))
copyFileSync(join(ROOT, 'LICENSE'), join(work, 'LICENSE.txt'))

// 4. The archive.
const archive = `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
rmSync(join(DIST, archive), { force: true })
// Windows' own tar (bsdtar) writes zip files; a Git or MSYS tar earlier on the PATH would not.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, process.platform === 'win32' ? ['-a', '-cf', archive, name] : ['-czf', archive, name], { cwd: DIST, stdio: 'inherit' })
console.log(`${join(DIST, archive)} (${seen.size} bundled packages)`)
