#!/usr/bin/env bash
# Legacy profile/fork installation route.
# Thin wrapper: forwards every argument to legacy/install.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec "${here}/legacy/install.sh" "$@"
