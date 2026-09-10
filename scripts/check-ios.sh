#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
swiftc_bin="${SWIFTC:-swiftc}"

if ! command -v "$swiftc_bin" >/dev/null 2>&1; then
  echo "swiftc not found; set SWIFTC to a Swift 5.10+ compiler" >&2
  exit 1
fi

"$swiftc_bin" -frontend -parse "$repo_dir"/Sources/*.swift "$repo_dir"/Tests/*.swift "$repo_dir"/ios-tests/*.swift
"$swiftc_bin" -typecheck "$repo_dir/Sources/ProjectDocument.swift" "$repo_dir/Sources/TimelineMath.swift" "$repo_dir/Sources/SubtitleSRT.swift" "$repo_dir/Sources/CubeLUT.swift" "$repo_dir/Sources/PCMFrameMath.swift"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
"$swiftc_bin" "$repo_dir/Sources/ProjectDocument.swift" "$repo_dir/ios-tests/ProjectDocumentSmoke.swift" -o "$work_dir/project-smoke"
"$work_dir/project-smoke"
"$swiftc_bin" "$repo_dir/Sources/ProjectDocument.swift" "$repo_dir/Sources/TimelineMath.swift" "$repo_dir/ios-tests/TimelineMathSmoke.swift" -o "$work_dir/timeline-smoke"
"$work_dir/timeline-smoke"
"$swiftc_bin" "$repo_dir/Sources/ProjectDocument.swift" "$repo_dir/Sources/SubtitleSRT.swift" "$repo_dir/ios-tests/SubtitleSRTSmoke.swift" -o "$work_dir/subtitle-smoke"
"$work_dir/subtitle-smoke"
"$swiftc_bin" "$repo_dir/Sources/CubeLUT.swift" "$repo_dir/ios-tests/CubeLUTSmoke.swift" -o "$work_dir/lut-smoke"
"$work_dir/lut-smoke"
"$swiftc_bin" "$repo_dir/Sources/PCMFrameMath.swift" "$repo_dir/ios-tests/PCMFrameMathSmoke.swift" -o "$work_dir/pcm-smoke"
"$work_dir/pcm-smoke"

echo "iOS static checks: passed"
