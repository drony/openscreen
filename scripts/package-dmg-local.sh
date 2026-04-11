#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_VERSION="1.3.0"
ARCH="${1:-arm64}"

case "${ARCH}" in
	arm64)
		APP_DIR="${REPO_ROOT}/release/${APP_VERSION}/mac-arm64"
		APP_PATH="${APP_DIR}/Openscreen.app"
		DMG_PATH="${REPO_ROOT}/release/${APP_VERSION}/Openscreen-Mac-arm64-${APP_VERSION}-Installer.dmg"
		;;
	x64)
		APP_DIR="${REPO_ROOT}/release/${APP_VERSION}/mac"
		APP_PATH="${APP_DIR}/Openscreen.app"
		DMG_PATH="${REPO_ROOT}/release/${APP_VERSION}/Openscreen-Mac-x64-${APP_VERSION}-Installer.dmg"
		;;
	*)
		echo "Unsupported architecture: ${ARCH}" >&2
		echo "Usage: ./scripts/package-dmg-local.sh [arm64|x64]" >&2
		exit 1
		;;
esac

if [[ ! -d "${APP_PATH}" ]]; then
	echo "Missing app bundle: ${APP_PATH}" >&2
	echo "Build it first with: npm run build:mac -- --${ARCH} --dir" >&2
	exit 1
fi

mkdir -p "$(dirname "${DMG_PATH}")"
rm -f "${DMG_PATH}"

hdiutil create \
	-volname "Openscreen" \
	-srcfolder "${APP_DIR}" \
	-ov \
	-format UDZO \
	"${DMG_PATH}"

echo
echo "Created DMG:"
echo "${DMG_PATH}"
