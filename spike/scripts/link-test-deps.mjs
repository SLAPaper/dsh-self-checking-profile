// Creates spike/node_modules/@deepseek-ai links to the local dsh fallback so
// the spike package can be imported from this repo without a pnpm install.
// spike/node_modules is gitignored.
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const fallback = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
const target = join(root, 'node_modules', '@deepseek-ai')
const packages = [
  'cordis',
  'dsh-bash-sandbox',
  'dsh-fs',
  'dsh-fs-sandbox',
  'dsh-permission-presets',
  'dsh-pwsh-local',
  'dsh-pwsh-sandbox',
  'dsh-sandbox',
  'dsh-sandbox-local',
  'dsh-sandbox-policy',
  'dsh-session',
  'dsh-shell',
  'dsh-subprocess-local'
]
if (!existsSync(join(fallback, packages[0]))) {
  console.error(`dsh fallback not found at ${fallback}; run dsh once or set DSH_HOME`)
  process.exit(1)
}
mkdirSync(target, { recursive: true })
for (const name of packages) {
  const source = join(fallback, name)
  if (!existsSync(source)) {
    console.error(`missing fallback package: ${source}`)
    process.exit(1)
  }
  const link = join(target, name)
  rmSync(link, { recursive: true, force: true })
  symlinkSync(realpathSync(source), link, process.platform === 'win32' ? 'junction' : 'dir')
}
console.log(`linked ${packages.length} fallback packages under ${target}`)
