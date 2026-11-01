#!/bin/bash
# Preppr orders for Mac: one-line install, no admin password, no Homebrew.
#
#   curl -fsSL <PREPPR_BASE_URL>/install.sh | bash
#
# Puts the preppr-orders program in ~/Preppr, a settings file in
# ~/.preppr/config.env, saves the iPhone backup password in the Keychain,
# and adds "Get today's orders" to the Desktop.
set -euo pipefail

# Where dist/preppr-orders-arm64 and dist/preppr-orders-x64 are uploaded (no trailing slash).
PREPPR_BASE_URL="${PREPPR_BASE_URL:-https://REPLACE-ME.example.com/preppr}"

APP_DIR="$HOME/Preppr"
BIN="$APP_DIR/preppr-orders"
CONF_DIR="$HOME/.preppr"
CONF="$CONF_DIR/config.env"
LAUNCHER="$HOME/Desktop/Get today's orders.command"

say() { printf '\n%s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  say "This installer is for Mac only."
  exit 1
fi
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) say "Unsupported Mac processor: $(uname -m)"; exit 1 ;;
esac

say "Installing Preppr orders…"
mkdir -p "$APP_DIR"
curl -fsSL "$PREPPR_BASE_URL/preppr-orders-$ARCH" -o "$BIN.download"
mv -f "$BIN.download" "$BIN"
chmod 755 "$BIN"
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
# Apple silicon refuses unsigned programs; an ad-hoc signature is enough for a local tool.
codesign -v "$BIN" 2>/dev/null || codesign --force --sign - "$BIN"

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<'CONF'
# Preppr settings. Ashwin fills in the key.
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
CONF
  chmod 600 "$CONF"
fi

cat > "$LAUNCHER" <<'CMD'
#!/bin/bash
clear
"$HOME/Preppr/preppr-orders"
echo
read -n 1 -s -r -p "Press any key to close this window."
CMD
chmod 755 "$LAUNCHER"

if [ -n "${PREPPR_SKIP_PASSWORD:-}" ]; then
  say "Skipped saving the backup password (PREPPR_SKIP_PASSWORD)."
else
say "Now the iPhone backup password (the one you chose in Finder when you turned on \"Encrypt local backup\")."
say "If your backup isn't encrypted, just press Return twice."
# stdin is this script (curl | bash), so read from the keyboard directly.
"$BIN" --save-password < /dev/tty || say "Password not saved. You can do it later: ~/Preppr/preppr-orders --save-password"
fi

say "Done. To get today's orders: back up the iPhone in Finder, then double-click \"Get today's orders\" on the Desktop."
