#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h:h}"
scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT
bundle="$scratch_dir/LocalizationChecks.app/Contents"
mkdir -p "$bundle/MacOS" "$bundle/Resources"
cp -R "$project_dir/Resources/"*.lproj "$bundle/Resources/"
cat > "$bundle/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LocalizationChecks</string>
<key>CFBundleIdentifier</key><string>local.codex-switch.localization-check</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>ko</string></array>
</dict></plist>
PLIST
xcrun swiftc -swift-version 5 "$project_dir/Sources/Localization.swift" "$project_dir/Tests/LocalizationChecks.swift" -o "$bundle/MacOS/LocalizationChecks"
"$bundle/MacOS/LocalizationChecks" -AppleLanguages '(ko)' --expect=ko
"$bundle/MacOS/LocalizationChecks" -AppleLanguages '(en)' --expect=en
"$bundle/MacOS/LocalizationChecks" -AppleLanguages '(fr)' --expect=en
"$bundle/MacOS/LocalizationChecks" -AppleLanguages '(ko-KR, en-US)' --expect=ko
