#!/usr/bin/env bash
# The shell plugin's pure Swift rules, without iOS or Capacitor (#98).
# Compiles the rule files with their checks and runs them. Linux or macOS:
#   bash native/shell/scripts/test-swift-logic.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/shell-native/ios/Sources/RouteIQNativePlugin"
tests="$here/shell-native/ios/Tests"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -O "$src/RouteIQStillness.swift" "$tests/RouteIQStillnessTests/main.swift" -o "$out/stillness"
"$out/stillness"
