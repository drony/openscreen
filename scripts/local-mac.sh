#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_VERSION="1.3.0"
ARM64_APP="${REPO_ROOT}/release/${APP_VERSION}/mac-arm64/Openscreen.app"
X64_APP="${REPO_ROOT}/release/${APP_VERSION}/mac/Openscreen.app"
LOCAL_CACHE_DIR="${REPO_ROOT}/.cache"
ELECTRON_NODE_MODULE_DIR="${REPO_ROOT}/node_modules/electron"
ELECTRON_PATH_FILE="${ELECTRON_NODE_MODULE_DIR}/path.txt"

mkdir -p "${LOCAL_CACHE_DIR}/electron" "${LOCAL_CACHE_DIR}/electron-builder" "${LOCAL_CACHE_DIR}/electron-get"
export ELECTRON_CACHE="${LOCAL_CACHE_DIR}/electron"
export ELECTRON_BUILDER_CACHE="${LOCAL_CACHE_DIR}/electron-builder"
export electron_config_cache="${LOCAL_CACHE_DIR}/electron-get"
export CSC_IDENTITY_AUTO_DISCOVERY=false

usage() {
	cat <<'EOF'
Usage:
  ./scripts/local-mac.sh run
  ./scripts/local-mac.sh debug-arm64
  ./scripts/local-mac.sh build-arm64
  ./scripts/local-mac.sh build-x64
  ./scripts/local-mac.sh open-arm64
  ./scripts/local-mac.sh open-x64

Commands:
  run          Start the local Vite/Electron dev flow with npm run dev
  debug-arm64  Build and open the packaged arm64 app for permission-sensitive debugging
  build-arm64  Build an unpacked macOS arm64 app bundle
  build-x64    Build an unpacked macOS x64 app bundle
  open-arm64   Open the built arm64 app in Finder/LaunchServices
  open-x64     Open the built x64 app in Finder/LaunchServices
EOF
}

ensure_app_exists() {
	local app_path="$1"
	if [[ ! -d "${app_path}" ]]; then
		echo "App not found: ${app_path}" >&2
		echo "Build it first with the matching build command." >&2
		exit 1
	fi
}

ensure_electron_runtime() {
	if [[ -f "${ELECTRON_PATH_FILE}" ]]; then
		return 0
	fi

	echo "Electron runtime missing. Installing local Electron binary..."
	node "${ELECTRON_NODE_MODULE_DIR}/install.js"
}

cd "${REPO_ROOT}"

case "${1:-}" in
	run)
		ensure_electron_runtime
		echo "Note: npm run dev uses the generic Electron app identity."
		echo "For Screen Recording permission debugging, prefer: ./scripts/local-mac.sh debug-arm64"
		exec npm run dev
		;;
	ensure-electron)
		ensure_electron_runtime
		echo "Electron runtime ready."
		;;
	debug-arm64)
		npm run build:mac -- --arm64 --dir
		ensure_app_exists "${ARM64_APP}"
		exec open "${ARM64_APP}"
		;;
	build-arm64)
		npm run build:mac -- --arm64 --dir
		echo
		echo "Built app:"
		echo "${ARM64_APP}"
		;;
	build-x64)
		npm run build:mac -- --x64 --dir
		echo
		echo "Built app:"
		echo "${X64_APP}"
		;;
	open-arm64)
		ensure_app_exists "${ARM64_APP}"
		exec open "${ARM64_APP}"
		;;
	open-x64)
		ensure_app_exists "${X64_APP}"
		exec open "${X64_APP}"
		;;
	""|-h|--help|help)
		usage
		;;
	*)
		echo "Unknown command: ${1}" >&2
		echo >&2
		usage >&2
		exit 1
		;;
esac
