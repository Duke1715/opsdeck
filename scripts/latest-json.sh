#!/usr/bin/env bash
# Rebuilds latest.json (the updater manifest) of a release from the signed files in it and uploads it.
# Each build job of tauri-action also patches latest.json, but jobs that finish at the same time
# overwrite each other's entries — so after all builds the manifest is assembled once, here.
# Usage (GH_TOKEN set, gh + jq available): scripts/latest-json.sh v0.5.0 [owner/repo]
set -euo pipefail
tag="$1"
repo="${2:-${GITHUB_REPOSITORY:-LeoAlecksey/opsdeck}}"
version="${tag#v}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

gh release download "$tag" --repo "$repo" --pattern '*.sig' --dir "$dir"
notes="$(gh release view "$tag" --repo "$repo" --json body --jq .body)"
base="https://github.com/$repo/releases/download/$tag"

# signed file → updater platform keys (the first key of each line is also the generic one, if set)
entries=()
add() { # add <file> <key> [<key>…]
  local file="$1"; shift
  [ -f "$dir/$file.sig" ] || return 0
  for key in "$@"; do entries+=("$key"$'\t'"$file"); done
}
add "OpsDeck_${version}_amd64.AppImage" linux-x86_64-appimage linux-x86_64
add "OpsDeck_${version}_amd64.deb" linux-x86_64-deb
add "OpsDeck-${version}-1.x86_64.rpm" linux-x86_64-rpm
add "OpsDeck_${version}_aarch64.AppImage" linux-aarch64-appimage linux-aarch64
add "OpsDeck_${version}_arm64.deb" linux-aarch64-deb
add "OpsDeck-${version}-1.aarch64.rpm" linux-aarch64-rpm
add "OpsDeck_${version}_x64_en-US.msi" windows-x86_64-msi windows-x86_64
add "OpsDeck_${version}_x64-setup.exe" windows-x86_64-nsis
add "OpsDeck_aarch64.app.tar.gz" darwin-aarch64-app darwin-aarch64
add "OpsDeck_x64.app.tar.gz" darwin-x86_64-app darwin-x86_64

platforms='{}'
for e in "${entries[@]}"; do
  key="${e%%$'\t'*}"; file="${e#*$'\t'}"
  platforms="$(jq --arg k "$key" --arg url "$base/$file" --rawfile sig "$dir/$file.sig" \
    '. + {($k): {signature: ($sig | rtrimstr("\n")), url: $url}}' <<<"$platforms")"
done

jq -n --arg v "$version" --arg notes "$notes" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson p "$platforms" \
  '{version: $v, notes: $notes, pub_date: $date, platforms: $p}' >"$dir/latest.json"
echo "latest.json for $tag: $(jq -r '.platforms | keys | join(", ")' "$dir/latest.json")"
gh release upload "$tag" "$dir/latest.json" --repo "$repo" --clobber
