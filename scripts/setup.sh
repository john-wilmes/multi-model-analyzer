#!/usr/bin/env bash
set -euo pipefail

# Multi-Model Analyzer -- macOS bootstrap
# Installs all prerequisites, clones the repo (if needed), and builds.
#
# Usage (from scratch):
#   curl -fsSL https://raw.githubusercontent.com/john-wilmes/multi-model-analyzer/main/scripts/setup.sh | bash
#
# Usage (already cloned):
#   ./scripts/setup.sh
#
# Idempotent -- safe to run multiple times.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
fail()  { echo -e "${RED}[setup]${NC} $*"; exit 1; }

REPO_URL="https://github.com/john-wilmes/multi-model-analyzer.git"
REPO_DIR="${MMA_DIR:-$HOME/multi-model-analyzer}"
NODE_MIN_VERSION=22
OLLAMA_MODEL="qwen2.5-coder:1.5b"

# ---------------------------------------------------------------------------
# 1. macOS check
# ---------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "This script targets macOS. For Linux, adapt the Homebrew sections."
fi

# ---------------------------------------------------------------------------
# 2. Xcode Command Line Tools (git, clang, etc.)
# ---------------------------------------------------------------------------
if ! xcode-select -p &>/dev/null; then
  info "Installing Xcode Command Line Tools..."
  xcode-select --install
  warn "After the installer finishes, re-run this script."
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Homebrew
# ---------------------------------------------------------------------------
if ! command -v brew &>/dev/null; then
  info "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
fi
info "Homebrew $(brew --version | head -1)"

# ---------------------------------------------------------------------------
# 4. Node.js 22+ via nvm
# ---------------------------------------------------------------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -d "$NVM_DIR" ]]; then
  info "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

CURRENT_NODE="$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo 0)"
if (( CURRENT_NODE < NODE_MIN_VERSION )); then
  info "Installing Node.js 22 LTS..."
  nvm install 22
  nvm use 22
  nvm alias default 22
fi
info "Node $(node --version), npm $(npm --version)"

# ---------------------------------------------------------------------------
# 5. GitHub CLI (for private repo clone)
# ---------------------------------------------------------------------------
if ! command -v gh &>/dev/null; then
  info "Installing GitHub CLI..."
  brew install gh
fi
if ! gh auth status &>/dev/null; then
  warn "GitHub CLI not authenticated. Running 'gh auth login'..."
  gh auth login
fi
info "gh $(gh --version | head -1)"

# ---------------------------------------------------------------------------
# 6. Clone repo (if not already inside it)
# ---------------------------------------------------------------------------
if [[ -f "package.json" ]] && grep -q "multi-model-analyzer" package.json 2>/dev/null; then
  REPO_DIR="$(pwd)"
  info "Already inside repo at $REPO_DIR"
elif [[ -d "$REPO_DIR/.git" ]]; then
  info "Repo already cloned at $REPO_DIR"
else
  info "Cloning repo to $REPO_DIR..."
  gh repo clone john-wilmes/multi-model-analyzer "$REPO_DIR"
fi
cd "$REPO_DIR"

# ---------------------------------------------------------------------------
# 7. System libraries (native deps for LevelDB, tree-sitter, SQLite)
# ---------------------------------------------------------------------------
BREW_PACKAGES=(leveldb sqlite meilisearch)
for pkg in "${BREW_PACKAGES[@]}"; do
  if ! brew list "$pkg" &>/dev/null; then
    info "Installing $pkg..."
    brew install "$pkg"
  fi
done
info "Brew packages: ${BREW_PACKAGES[*]}"

# ---------------------------------------------------------------------------
# 8. Ollama (local LLM runtime for tier 3 summarization)
# ---------------------------------------------------------------------------
if ! command -v ollama &>/dev/null; then
  info "Installing Ollama..."
  brew install ollama
fi
info "Ollama $(ollama --version 2>/dev/null || echo 'installed')"

# Pull the model (non-blocking if Ollama server isn't running yet)
if ollama list 2>/dev/null | grep -q "$OLLAMA_MODEL"; then
  info "Ollama model $OLLAMA_MODEL already pulled"
else
  info "Pulling Ollama model $OLLAMA_MODEL (this may take a few minutes)..."
  ollama pull "$OLLAMA_MODEL" || warn "Could not pull model -- start 'ollama serve' first, then run: ollama pull $OLLAMA_MODEL"
fi

# ---------------------------------------------------------------------------
# 9. npm install + build
# ---------------------------------------------------------------------------
info "Installing npm dependencies..."
npm install

info "Building TypeScript..."
npm run build

# ---------------------------------------------------------------------------
# 10. Global npm tools
# ---------------------------------------------------------------------------
GLOBAL_TOOLS=(
  "dependency-cruiser"
  "@sourcegraph/scip-typescript"
)
for tool in "${GLOBAL_TOOLS[@]}"; do
  PKG_NAME="$(echo "$tool" | sed 's/@.*//' | sed 's/.*\///')"
  if ! command -v "$PKG_NAME" &>/dev/null && ! npx --yes "$tool" --version &>/dev/null 2>&1; then
    info "Installing $tool globally..."
    npm install -g "$tool" || warn "Could not install $tool globally -- will use npx at runtime"
  fi
done

# tree-sitter CLI (needed for grammar compilation)
if ! command -v tree-sitter &>/dev/null; then
  info "Installing tree-sitter CLI..."
  brew install tree-sitter || npm install -g tree-sitter-cli
fi

# ---------------------------------------------------------------------------
# 11. Create local data directories
# ---------------------------------------------------------------------------
mkdir -p "$REPO_DIR/data/mirrors"
mkdir -p "$REPO_DIR/data/indexes"
mkdir -p "$REPO_DIR/data/meilisearch"

# ---------------------------------------------------------------------------
# 12. Verify
# ---------------------------------------------------------------------------
info ""
info "============================================"
info " Setup complete"
info "============================================"
info ""
info " Repo:        $REPO_DIR"
info " Node:        $(node --version)"
info " TypeScript:  $(npx tsc --version)"
info " tree-sitter: $(tree-sitter --version 2>/dev/null || echo 'via npx')"
info " Ollama:      $(ollama --version 2>/dev/null || echo 'installed')"
info " MeiliSearch: $(meilisearch --version 2>/dev/null || echo 'installed')"
info ""
info " Next steps:"
info "   1. Create mma.config.json with your target repos"
info "   2. Start MeiliSearch:  meilisearch --db-path ./data/meilisearch"
info "   3. Start Ollama:       ollama serve"
info "   4. Run indexing:       npx mma index -v"
info ""
