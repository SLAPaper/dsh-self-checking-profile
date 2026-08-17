#!/usr/bin/env node
// Install the spike package into a local dsh profile for end-to-end testing:
//   node scripts/install-dev-profile.mjs [--profile self-checking-spike] [--dsh-home ~/.dsh] [--force]
//
// This mimics what `dsh plugin --profile <name> add dsh-self-checking` will
// do once the package is published, without needing pnpm or a registry.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const take = (flag, fallback) => {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${flag} requires a value`)
  args.splice(index, 2)
  return value
}
const profile = take('--profile', 'self-checking-spike')
const dshHome = resolve(take('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const force = args.includes('--force')
if (args.length > 0) throw new Error(`unknown arguments: ${args.join(' ')}`)

const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const destProfile = join(dshHome, 'profiles', profile)
const destPkg = join(destProfile, 'node_modules', pkgName)

if (existsSync(destProfile)) {
  if (!force) throw new Error(`${destProfile} already exists (use --force)`)
  rmSync(destProfile, { recursive: true, force: true })
}
mkdirSync(join(destPkg, 'scripts'), { recursive: true })
for (const entry of ['lib', 'cordis.patch.yml', 'package.json', 'README.md']) {
  cpSync(join(root, entry), join(destPkg, entry), { recursive: true })
}
cpSync(join(root, 'scripts', 'verify-installed.mjs'), join(destPkg, 'scripts', 'verify-installed.mjs'))
writeFileSync(join(destProfile, 'package.json'), JSON.stringify({
  name: `dsh-profile-${profile}`,
  private: true,
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        pkgName
      ]
    }
  }
}, null, 2) + '\n')

const fallback = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-base')
if (!existsSync(fallback)) {
  console.error(`warning: pristine dsh fallback not found at ${fallback}`)
  console.error('run any dsh 0.1.0-rc.6 profile once before starting this one')
}
console.log(`installed ${pkgName} into ${destProfile}`)
console.log(`verify: node ${join(destPkg, 'scripts', 'verify-installed.mjs')} --profile ${basename(profile)} --dsh-home ${dshHome}`)
console.log(`start: npx @deepseek-ai/dsh --profile ${basename(profile)}`)
