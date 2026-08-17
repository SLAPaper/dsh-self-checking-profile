#!/usr/bin/env node
// Installed-profile verifier for dsh-self-checking:
//   node scripts/verify-installed.mjs --profile <name> [--dsh-home <path>] [--strict]
//
// Checks that the package is present under the profile, the profile bundle
// list includes it, and (when a dsh CLI is available) that the composed
// config has the three native service rows disabled and the self-checking
// preset inserted. `--strict` fails when the dsh CLI cannot be found;
// otherwise the static checks alone pass with a warning.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const take = (flag, fallback) => {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${flag} requires a value`)
  args.splice(index, 2)
  return value
}
const profile = take('--profile', 'web')
const dshHome = resolve(take('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const strict = args.includes('--strict')
if (strict) args.splice(args.indexOf('--strict'), 1)
if (args.length > 0) throw new Error(`unknown arguments: ${args.join(' ')}`)

let failures = 0
const check = (cond, label) => {
  if (cond) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label}`) }
}

const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
check(existsSync(manifestPath), `profile manifest exists: ${manifestPath}`)
let manifest = {}
if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
check(bundles.includes(expected.name), `profile bundles include ${expected.name}`)

const installedDir = join(profileDir, 'node_modules', expected.name)
const installedManifestPath = join(installedDir, 'package.json')
check(existsSync(installedManifestPath), `package installed at ${installedDir}`)
let installed = {}
if (existsSync(installedManifestPath)) {
  installed = JSON.parse(readFileSync(installedManifestPath, 'utf8'))
  check(installed.name === expected.name, `installed package name is ${expected.name}`)
  check(installed.version === expected.version, `installed version is ${expected.version}`)
  check(existsSync(join(installedDir, 'lib', 'index.js')), 'installed lib/index.js exists')
  check(existsSync(join(installedDir, 'cordis.patch.yml')), 'installed cordis.patch.yml exists')
}

// Optional composed-config verification. In a brand-new DSH_HOME the dsh
// fallback may not exist until the first boot; strict mode turns that into a
// failure for CI/acceptance use.
const dshBinCandidates = [
  process.env.DSH_BIN,
  join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
].filter((candidate) => candidate !== undefined && candidate !== '')
const dshBin = dshBinCandidates.find((candidate) => existsSync(candidate))
if (dshBin === undefined) {
  if (strict) {
    failures += 1
    console.error(`  FAIL: dsh CLI not found; run dsh once or set DSH_BIN (checked: ${dshBinCandidates.join(', ')})`)
  } else {
    console.log('  warn: dsh CLI not found; composed-config checks skipped')
  }
} else {
  const dump = spawnSync(process.execPath, [dshBin, '--profile', profile, '--dump-default-config'], {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8'
  })
  check(dump.status === 0, `dsh --dump-default-config exits 0\n${dump.stderr?.slice(-2000) ?? ''}`)
  if (dump.status === 0) {
    const text = dump.stdout

    const entryHasDisabled = (id) => {
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!/^\s*- id: /.test(lines[index])) continue
        const currentId = lines[index].match(/^\s*- id: (.*)$/)?.[1]
        if (currentId !== id) continue
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const line = lines[cursor]
          if (/^\s*-\s+(id|insert):/.test(line)) break
          if (/^\s+disabled:\s*true\s*$/.test(line)) return true
        }
        return false
      }
      return false
    }

    const entryName = (id) => {
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^\s*- id: (.*)$/)
        if (match?.[1] !== id) continue
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
          const line = lines[cursor]
          if (/^\s*-\s+(id|insert):/.test(line)) break
          const name = line.match(/^\s+name:\s*(.*)$/)
          if (name) return name[1].trim().replace(/^'|'$/g, '')
        }
      }
      return ''
    }

    check(entryHasDisabled('bash-sandbox'), 'bash-sandbox row disabled in composed config')
    check(entryHasDisabled('pwsh-sandbox'), 'pwsh-sandbox row disabled in composed config')
    check(entryHasDisabled('fs-sandbox'), 'fs-sandbox row disabled in composed config')
    check(text.includes('name: 🛡️🔍 Self Checking'), 'emoji preset name present in composed config')
    check(entryName('self-checking') === expected.name, `self-checking plugin row is ${expected.name}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} INSTALLED-PROFILE CHECK(S) FAILED`)
  process.exit(1)
}
console.log(`\n${expected.name}@${expected.version} installed-profile checks passed for ${profileDir}`)
