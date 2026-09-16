#!/bin/zsh
set -euo pipefail
project_dir="${0:A:h}"
output_dir="${CODEX_SWITCH_BUILD_DIR:-$project_dir/dist}"
app_path="$output_dir/Codex Switch.app"
runtime_version="24.21.0"
architecture="$(uname -m)"
case "$architecture" in
  arm64) runtime_arch=arm64; runtime_sha=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  x86_64) runtime_arch=x64; runtime_sha=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  *) print -u2 "Unsupported architecture: $architecture"; exit 1 ;;
esac
runtime_name="node-v$runtime_version-darwin-$runtime_arch"
cache_dir="$project_dir/.build"
archive="$cache_dir/$runtime_name.tar.gz"
mkdir -p "$cache_dir"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v$runtime_version/$runtime_name.tar.gz" -o "$archive.download"
  mv "$archive.download" "$archive"
fi
actual_sha="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
if [[ "$actual_sha" != "$runtime_sha" ]]; then
  print -u2 "Node checksum mismatch. Remove $archive and try again."
  exit 1
fi
tar -xzf "$archive" -C "$cache_dir" "$runtime_name/bin/node" "$runtime_name/LICENSE"
runtime_source="$cache_dir/$runtime_name"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/Backend" "$app_path/Contents/Resources/Runtime"
xcrun swiftc -O -swift-version 5 -target "$architecture-apple-macosx14.0" -parse-as-library \
  -framework AppKit -framework SwiftUI -framework ServiceManagement \
  "$project_dir/Sources/"*.swift -o "$app_path/Contents/MacOS/CodexSwitch"
cp "$project_dir/Backend/"*.mjs "$app_path/Contents/Resources/Backend/"
cp "$runtime_source/bin/node" "$app_path/Contents/Resources/Runtime/node"
cp "$runtime_source/LICENSE" "$app_path/Contents/Resources/Runtime/LICENSE"
cp "$project_dir/LICENSE" "$project_dir/THIRD_PARTY_NOTICES.md" "$app_path/Contents/Resources/"
cat > "$app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CodexSwitch</string>
<key>CFBundleIdentifier</key><string>local.codex-switch</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>ko</string></array>
<key>CFBundleName</key><string>Codex Switch</string>
<key>CFBundleDisplayName</key><string>Codex Switch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.6.0</string>
<key>CFBundleVersion</key><string>9</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
PLIST
cp -R "$project_dir/Resources/"*.lproj "$app_path/Contents/Resources/"
cp "$project_dir/Assets/"*.png "$app_path/Contents/Resources/"
xcrun swift "$project_dir/Tools/icon.swift" "$app_path/Contents/Resources" "$project_dir/Assets"
/usr/bin/codesign --force --sign - "$app_path/Contents/Resources/Runtime/node"
/usr/bin/codesign --force --sign - "$app_path"
/usr/bin/codesign --verify --deep --strict "$app_path"
print "Built: $app_path"
