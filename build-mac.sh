#!/usr/bin/env bash
# build-mac.sh — gera o Abel Drive (.dmg + .zip) UNIVERSAL.
#
# O truque da Opção B: o rclone universal (~110 MB) NÃO vai pro git (estouraria
# o limite de 100 MB do GitHub). Ele entra em bin/ SÓ durante o build, e no fim
# (mesmo se der erro) o bin/rclone commitado é restaurado. O git fica leve; o
# .dmg sai completo e nativo pra Intel e Apple Silicon.
#
# ── Pré-requisito (uma vez só) ────────────────────────────────────────────────
# Ter um rclone UNIVERSAL em ~/abel-rclone-universal (ou aponte a variável
# ABEL_RCLONE_UNIVERSAL pra ele). Como criar, no seu Mac:
#   cd ~/Downloads
#   curl -LO https://downloads.rclone.org/rclone-current-osx-amd64.zip
#   curl -LO https://downloads.rclone.org/rclone-current-osx-arm64.zip
#   unzip -o rclone-current-osx-amd64.zip
#   unzip -o rclone-current-osx-arm64.zip
#   lipo -create rclone-*-osx-amd64/rclone rclone-*-osx-arm64/rclone \
#        -output ~/abel-rclone-universal
#   chmod +x ~/abel-rclone-universal
#   lipo -info ~/abel-rclone-universal        # deve dizer: x86_64 arm64
#
# ── Uso ───────────────────────────────────────────────────────────────────────
#   chmod +x build-mac.sh        # uma vez
#   ./build-mac.sh               # gera dist/*.dmg e dist/*.zip
set -euo pipefail
cd "$(dirname "$0")"

UNI="${ABEL_RCLONE_UNIVERSAL:-$HOME/abel-rclone-universal}"
if [ ! -f "$UNI" ]; then
  echo "✗ rclone universal não encontrado em: $UNI"
  echo "  Crie-o uma vez (veja o cabeçalho deste arquivo) e rode de novo."
  exit 1
fi

# Restaura o bin/rclone do git ao sair (sucesso OU erro) — nunca commita o universal.
restore() { git checkout -- bin/rclone 2>/dev/null || true; }
trap restore EXIT

echo "→ colocando o rclone universal em bin/rclone"
cp "$UNI" bin/rclone
chmod +x bin/rclone
printf "  arquiteturas: "; lipo -info bin/rclone || true

echo "→ buildando (.dmg + .zip, universal) — isso baixa o Electron das duas arquiteturas na 1ª vez…"
npm run dist:mac

echo "✓ pronto. Artefatos em dist/  (bin/rclone restaurado do git)"
