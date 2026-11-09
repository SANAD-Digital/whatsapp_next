#!/usr/bin/env bash
# Install what the server needs to draw the PDFs WhatsappNext attaches to messages (invoices,
# statements, print formats, report alerts): the system libraries Frappe's Chromium needs, and
# Chromium itself.
#
# A Print Format whose "PDF Generator" is Chrome is drawn by the Chromium Frappe keeps in
# `frappe-bench/chromium`. That binary needs system libraries a bare server does not have; without
# them it never starts ("libnss3.so: cannot open shared object file", then "Chromium took too long
# to start"). The app falls back to wkhtmltopdf when that happens, but a format made for Chrome
# looks right only in Chrome.
#
# Frappe Cloud installs the same packages from `pyproject.toml` → `[deploy.dependencies.apt]`.
# A bench you run yourself does not, so:
#
#   sudo apps/whatsapp_next/scripts/install_pdf_deps.sh        (from frappe-bench, as root)
#
# then, as the bench user:   bench setup-chrome && bench restart
#
# Ubuntu 22.04, 24.04 and Debian 12 (24.04 renamed several libraries with a `t64` suffix; the
# script picks whichever name the system has). Running it again is safe.
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
	echo "Run it with sudo: it installs system packages." >&2
	exit 1
fi
command -v apt-get >/dev/null || { echo "This script is for Debian / Ubuntu (apt-get)." >&2; exit 1; }

apt-get update -qq

# each name, or its `t64` form where only that one exists (Ubuntu 24.04)
pick() {
	local name="$1"
	if apt-cache show "${name}t64" >/dev/null 2>&1 && ! apt-cache show "$name" 2>/dev/null | grep -q '^Version'; then
		echo "${name}t64"
	else
		echo "$name"
	fi
}

PACKAGES=(
	libnss3 libnspr4 libdbus-1-3 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3
	libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libxshmfence1 libx11-6 libxcb1 libxext6
	fonts-liberation ca-certificates
	"$(pick libatk1.0-0)" "$(pick libatk-bridge2.0-0)" "$(pick libcups2)"
	"$(pick libatspi2.0-0)" "$(pick libasound2)" "$(pick libglib2.0-0)"
)

echo "Installing: ${PACKAGES[*]}"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"

BENCH="$(cd "$(dirname "$0")/../../.." && pwd)"
SHELL_BIN="$BENCH/chromium/chrome-linux/headless_shell"
if [[ -x "$SHELL_BIN" ]]; then
	if missing="$(ldd "$SHELL_BIN" | grep 'not found')"; then
		echo "Chromium still lacks:" >&2
		echo "$missing" >&2
		exit 1
	fi
	echo "Chromium: $("$SHELL_BIN" --version)"
	echo "Done. Restart the bench as its user: bench restart"
else
	echo "Done. Now, as the bench user, from $BENCH:  bench setup-chrome && bench restart"
fi
