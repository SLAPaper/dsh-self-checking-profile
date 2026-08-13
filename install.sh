#!/usr/bin/env bash
# Install the Self Checking dsh profile (macOS / Linux / Git-Bash).
# Usage:
#   ./install.sh [-p self-checking] [-h <dsh-home>] [-f]
set -euo pipefail
PROFILE="self-checking"
DSH_HOME="${HOME}/.dsh"
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PROFILE="$2"; shift 2 ;;
    -h) DSH_HOME="$2"; shift 2 ;;
    -f) FORCE=1; shift ;;
    *) echo "usage: $0 [-p profile] [-h dsh-home] [-f]" >&2; exit 2 ;;
  esac
done
here="$(cd "$(dirname "$0")" && pwd)"
src="${here}/profile"
dest="${DSH_HOME}/profiles/${PROFILE}"

[[ -d "${src}" ]] || { echo "profile template not found: ${src}" >&2; exit 1; }
if [[ -e "${dest}" ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then echo "profile '${PROFILE}' already exists at ${dest} (use -f to overwrite)" >&2; exit 1; fi
  rm -rf "${dest}"
fi
mkdir -p "$(dirname "${dest}")"
cp -R "${src}" "${dest}"
cp "${here}/verify.mjs" "${dest}/"

# Assemble the fork layer: profile/forks is the source of truth; node_modules
# is generated (or created by `dsh plugin --profile X install`).
fork_source="${dest}/forks"
fork_target="${dest}/node_modules/@deepseek-ai"
[[ -d "${fork_source}" ]] || { echo "fork sources missing: ${fork_source}" >&2; exit 1; }
if [[ ! -d "${fork_target}/dsh-sandbox" ]]; then
  mkdir -p "${fork_target}"
  for pkg in "${fork_source}"/*; do cp -R "${pkg}" "${fork_target}/$(basename "${pkg}")"; done
  echo "assembled fork layer ($(find "${fork_target}" -mindepth 1 -maxdepth 1 -type d | wc -l) packages)"
else
  echo "fork layer already present"
fi

echo "installed profile at ${dest}"
echo "optional: manage the fork layer with pnpm instead — run: dsh plugin --profile ${PROFILE} install"

fallback="${DSH_HOME}/profiles/node_modules/@deepseek-ai"
if [[ ! -d "${fallback}/dsh-sandbox" ]]; then
  echo "warning: pristine @deepseek-ai install not found at ${fallback} — run any dsh profile once (or install dsh 0.1.0-rc.6) so the shared module fallback exists" >&2
fi
echo "running verification..."
node "${dest}/verify.mjs" --profile "${dest}"
echo ""
echo "done. Start it with:"
echo "  npx @deepseek-ai/dsh --profile ${PROFILE}"
