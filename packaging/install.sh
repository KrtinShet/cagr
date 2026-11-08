#!/bin/sh
# Installs the cagr binary.
#   curl -fsSL <url>/install.sh | sh
# Env: CAGR_VERSION (default latest), CAGR_INSTALL_DIR (default ~/.local/bin),
#      CAGR_DOWNLOAD_URL (default the GitHub release for the version).
set -eu

repo="${CAGR_REPO:-krtinshet/cagr}"
version="${CAGR_VERSION:-latest}"
dir="${CAGR_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) echo "cagr: unsupported OS $(uname -s). On Windows, download cagr-windows-x64.exe from the release." >&2; exit 1 ;;
esac
case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) echo "cagr: unsupported CPU $(uname -m)." >&2; exit 1 ;;
esac
suffix=""
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then suffix="-musl"; fi
asset="cagr-$os-$arch$suffix"

if [ -n "${CAGR_DOWNLOAD_URL:-}" ]; then base="$CAGR_DOWNLOAD_URL"
elif [ "$version" = latest ]; then base="https://github.com/$repo/releases/latest/download"
else base="https://github.com/$repo/releases/download/v$version"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset from $base"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
expected="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
else actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
	echo "cagr: checksum mismatch for $asset." >&2
	exit 1
fi

mkdir -p "$dir"
mv "$tmp/$asset" "$dir/cagr"
chmod 755 "$dir/cagr"
echo "Installed $("$dir/cagr" --version) to $dir/cagr"
case ":$PATH:" in *":$dir:"*) ;; *) echo "Add $dir to your PATH." ;; esac
if [ "$suffix" = "-musl" ]; then echo "On Alpine, cagr needs: apk add libstdc++ libgcc"; fi
