#!/usr/bin/env bash
# Install the WhatsappNext brand fonts on the server: IBM Plex Sans Arabic and Sora.
#
# The browser needs nothing: the app ships the fonts itself (whatsapp_next/public/fonts, woff2).
# The server needs them for what it draws without a browser — the PDFs it attaches to messages
# (invoices, statements, print formats). Without them an Arabic PDF falls back to whatever font
# the server has.
#
# Both fonts are SIL Open Font License 1.1, downloaded from the official Google Fonts repository.
#
#   scripts/install_fonts.sh            for the bench user  (~/.local/share/fonts/whatsappnext)
#   sudo scripts/install_fonts.sh --system   for every user (/usr/local/share/fonts/whatsappnext)
#
# Run it as the user the bench runs as (the one that renders PDFs). Running it again is safe.
set -euo pipefail

SOURCE="https://raw.githubusercontent.com/google/fonts/main/ofl"
FILES=(
	"ibmplexsansarabic/IBMPlexSansArabic-Light.ttf"
	"ibmplexsansarabic/IBMPlexSansArabic-Regular.ttf"
	"ibmplexsansarabic/IBMPlexSansArabic-SemiBold.ttf"
	"ibmplexsansarabic/IBMPlexSansArabic-Bold.ttf"
	"ibmplexsansarabic/OFL.txt"
	"sora/Sora%5Bwght%5D.ttf"
	"sora/OFL.txt"
)

if [[ "${1:-}" == "--system" ]]; then
	TARGET="/usr/local/share/fonts/whatsappnext"
else
	TARGET="${FONT_DIR:-$HOME/.local/share/fonts/whatsappnext}"
fi

for tool in curl fc-cache; do
	command -v "$tool" >/dev/null || { echo "Missing: $tool (install fontconfig and curl first)" >&2; exit 1; }
done

mkdir -p "$TARGET"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for file in "${FILES[@]}"; do
	name="$(basename "${file//%5B/[}")"
	name="${name//%5D/]}"
	# the two licences share a name: keep both, each beside its font
	[[ "$name" == "OFL.txt" ]] && name="OFL-$(dirname "$file").txt"
	echo "Downloading $name"
	curl -fsSL --retry 3 -o "$TMP/$name" "$SOURCE/$file"
done

cp "$TMP"/* "$TARGET"/
fc-cache -f "$TARGET" >/dev/null
echo "Installed in $TARGET:"
fc-list : family | grep -iE "IBM Plex Sans Arabic|Sora" | sort -u
