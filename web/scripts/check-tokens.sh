#!/usr/bin/env bash
# Governing: SPEC-0005 REQ "Token Discipline"
#
# "WHEN the stylesheet is searched for colour literals outside the token file
#  THEN none is found, and every component colour resolves through a custom
#  property."
#
# Stylelint enforces this for .css. This covers .ts/.tsx as well, where an
# inline style attribute is just as capable of carrying a literal and
# stylelint does not look.
set -euo pipefail
cd "$(dirname "$0")/.."

# 3, 4, 6 or 8 hex digits after a #, plus the CSS colour functions. The token
# file is the one place any of them is allowed.
pattern='#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\('

offenders=$(grep -rInE "$pattern" src \
  --include='*.ts' --include='*.tsx' --include='*.css' \
  | grep -v '^src/styles/tokens.css:' || true)

if [ -n "$offenders" ]; then
  echo "Colour literals found outside src/styles/tokens.css:"
  echo "$offenders"
  echo
  echo "Add the value to the token file with its design provenance, or"
  echo "reference an existing custom property."
  exit 1
fi

echo "No colour literals outside the token file."
