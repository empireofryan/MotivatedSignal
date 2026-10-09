#!/usr/bin/env bash
# Encrypt/decrypt the project's private planning docs with age.
#
# Usage:
#   scripts/secrets.sh encrypt   # plaintext -> .age (run before committing)
#   scripts/secrets.sh decrypt   # .age -> plaintext (run after a fresh clone)
#
# The plaintext files are gitignored; only the .age files are committed.
# Decryption needs the private key at ~/.config/motivatedsignal/age.key.
# See CLAUDE.md -> "Private files" for details and what losing the key means.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

AGE_KEY="${AGE_KEY:-$HOME/.config/motivatedsignal/age.key}"
AGE_PUBKEY="age1gx3t87tywpng04zu7ppt2x8sz0nlrm0x3gwmh2p7ptp7texy89rq6urwcv"

FILES=(
  "CLAUDE.md"
  "docs/outreach-plan.md"
  "docs/competitors.md"
)

cmd="${1:-}"

case "$cmd" in
  encrypt)
    for f in "${FILES[@]}"; do
      if [ ! -f "$f" ]; then
        echo "skip (missing): $f"
        continue
      fi
      age -r "$AGE_PUBKEY" -o "$f.age" "$f"
      echo "encrypted: $f -> $f.age"
    done
    ;;
  decrypt)
    if [ ! -f "$AGE_KEY" ]; then
      echo "Private key not found at $AGE_KEY — cannot decrypt." >&2
      exit 1
    fi
    for f in "${FILES[@]}"; do
      if [ ! -f "$f.age" ]; then
        echo "skip (missing): $f.age"
        continue
      fi
      age -d -i "$AGE_KEY" -o "$f" "$f.age"
      echo "decrypted: $f.age -> $f"
    done
    ;;
  *)
    echo "Usage: $0 {encrypt|decrypt}" >&2
    exit 1
    ;;
esac
