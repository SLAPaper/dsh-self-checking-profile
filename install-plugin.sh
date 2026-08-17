#!/usr/bin/env bash
# Plugin installation route (local checkout, no npm publish required).
# Usage: ./install-plugin.sh [-p web] [-h <dsh-home>]
set -euo pipefail
PROFILE="web"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PROFILE="$2"; shift 2 ;;
    -h) DSH_HOME="$2"; shift 2 ;;
    *) echo "usage: $0 [-p profile] [-h dsh-home]" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
plugin_dir="${here}/plugin"
[[ -d "${plugin_dir}" ]] || { echo "plugin package not found: ${plugin_dir}" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) plugin_spec="file:$(cygpath -m "${plugin_dir}")" ;;
  *) plugin_spec="file:${plugin_dir}" ;;
esac

if command -v dsh >/dev/null 2>&1; then
  dsh_cmd=(dsh)
else
  dsh_cmd=(npx --yes @deepseek-ai/dsh)
fi

echo "adding ${plugin_spec} to profile ${PROFILE} (DSH_HOME=${DSH_HOME}) ..."
DSH_HOME="${DSH_HOME}" "${dsh_cmd[@]}" plugin --profile "${PROFILE}" add "${plugin_spec}"

verify="${DSH_HOME}/profiles/${PROFILE}/node_modules/dsh-self-checking/scripts/verify-installed.mjs"
if [[ -f "${verify}" ]]; then
  echo "running installed-profile verification..."
  DSH_HOME="${DSH_HOME}" node "${verify}" --profile "${PROFILE}" --dsh-home "${DSH_HOME}" --strict
else
  echo "warning: installed verifier not found at ${verify}" >&2
fi

echo ""
echo "done. Restart dsh web, then hard-refresh the browser."
echo "Start with: npx @deepseek-ai/dsh --profile ${PROFILE}"
