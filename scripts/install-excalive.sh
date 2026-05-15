#!/usr/bin/env bash
set -euo pipefail

REPO="NikolaStarx/obsidian-excalidraw-plugin"
PLUGIN_ID="obsidian-excalive-plugin"
DEFAULT_TAG="excalive-v2.22.3-live.1"

if [ "${EXCALIVE_TAG:-}" != "" ]; then
  TAG="$EXCALIVE_TAG"
else
  TAG="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" |
      sed -n 's/.*"tag_name": *"\(excalive-[^"]*\)".*/\1/p' |
      head -n 1
  )"
  TAG="${TAG:-$DEFAULT_TAG}"
fi

BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"

choose_vault() {
  if [ "${1:-}" != "" ]; then
    printf '%s\n' "$1"
    return
  fi

  if command -v osascript >/dev/null 2>&1; then
    osascript <<'APPLESCRIPT'
POSIX path of (choose folder with prompt "Select your Obsidian vault")
APPLESCRIPT
    return
  fi

  printf 'Obsidian vault path: ' >&2
  IFS= read -r vault_path
  printf '%s\n' "$vault_path"
}

VAULT="$(choose_vault "${1:-}")"
case "$VAULT" in
  "~") VAULT="$HOME" ;;
  "~/"*) VAULT="$HOME/${VAULT#~/}" ;;
esac
VAULT="${VAULT%/}"

if [ "$VAULT" = "" ]; then
  echo "No vault selected." >&2
  exit 1
fi

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "This does not look like an Obsidian vault: $VAULT" >&2
  echo "Missing folder: $VAULT/.obsidian" >&2
  exit 1
fi

PLUGIN_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for file in main.js manifest.json styles.css; do
  echo "Downloading $file"
  curl -fL "$BASE_URL/$file" -o "$TMP_DIR/$file"
done

mkdir -p "$PLUGIN_DIR"
cp "$TMP_DIR/main.js" "$TMP_DIR/manifest.json" "$TMP_DIR/styles.css" "$PLUGIN_DIR/"

echo
echo "Installed Excalive $TAG to:"
echo "$PLUGIN_DIR"
echo
echo "Next steps:"
echo "1. Restart or reload Obsidian."
echo "2. Enable Excalive in Community plugins."
echo "3. If you use Excalive as your main drawing plugin, disable the original Excalidraw plugin."
