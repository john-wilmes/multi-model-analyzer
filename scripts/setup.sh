#!/usr/bin/env bash
set -euo pipefail

# Multi-Model Analyzer -- bootstrap script (macOS + Linux)
# Installs all prerequisites, clones the repo (if needed), and builds.
#
# Usage (from scratch):
#   curl -fsSL https://raw.githubusercontent.com/<GITHUB_USER>/multi-model-analyzer/main/scripts/setup.sh | bash
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

# --- Configuration (auto-detected or override via environment) ----------------
GITHUB_USER="${MMA_GITHUB_USER:-john-wilmes}"
REPO_DIR="${MMA_DIR:-$HOME/multi-model-analyzer}"
NODE_MIN_VERSION=22
OLLAMA_MODEL="qwen2.5-coder:1.5b"
export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"
export HOMEBREW_NO_INTERACTIVE=1

# --- Detect platform ----------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      fail "Unsupported platform: $OS. This script supports macOS and Linux." ;;
esac
info "Detected platform: $PLATFORM"

# --- Helper: install a system package -----------------------------------------
install_pkg() {
  local pkg="$1"
  if [[ "$PLATFORM" == "macos" ]]; then
    if ! brew list "$pkg" &>/dev/null; then
      info "Installing $pkg via Homebrew..."
      brew install "$pkg"
    fi
  elif [[ "$PLATFORM" == "linux" ]]; then
    if command -v apt-get &>/dev/null; then
      if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
        info "Installing $pkg via apt-get..."
        sudo apt-get install -y "$pkg"
      fi
    else
      warn "No supported package manager found. Please install '$pkg' manually."
    fi
  fi
}

# ---------------------------------------------------------------------------
# 1. macOS-specific: Xcode Command Line Tools + Homebrew
# ---------------------------------------------------------------------------
if [[ "$PLATFORM" == "macos" ]]; then
  if ! xcode-select -p &>/dev/null; then
    info "Installing Xcode Command Line Tools..."
    # Try headless install first (works in CI/agent environments)
    if touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress 2>/dev/null; then
      XCODE_PKG=$(softwareupdate -l 2>/dev/null | grep -o '.*Command Line Tools.*' | head -1 | sed 's/^[* ]*//')
      if [[ -n "$XCODE_PKG" ]]; then
        softwareupdate -i "$XCODE_PKG" --verbose
        rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
      else
        rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
        xcode-select --install
        warn "After the installer finishes, re-run this script."
        exit 0
      fi
    else
      xcode-select --install
      warn "After the installer finishes, re-run this script."
      exit 0
    fi
  fi

  if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
  fi
  info "Homebrew $(brew --version | head -1)"
fi

# ---------------------------------------------------------------------------
# 2. Node.js 22+ via nvm
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
# 3. GitHub CLI (for private repo clone)
# ---------------------------------------------------------------------------
if ! command -v gh &>/dev/null; then
  info "Installing GitHub CLI..."
  if [[ "$PLATFORM" == "macos" ]]; then
    brew install gh
  elif command -v apt-get &>/dev/null; then
    # Official GitHub CLI installation for Debian/Ubuntu
    sudo mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update && sudo apt-get install -y gh
  else
    warn "Please install GitHub CLI manually: https://github.com/cli/cli#installation"
  fi
fi
if ! gh auth status &>/dev/null; then
  if [[ -n "${GH_TOKEN:-}" ]]; then
    info "Authenticating GitHub CLI via GH_TOKEN..."
    echo "$GH_TOKEN" | gh auth login --with-token
  else
    warn "GitHub CLI not authenticated. Running 'gh auth login'..."
    gh auth login
  fi
fi
info "gh $(gh --version | head -1)"

# ---------------------------------------------------------------------------
# 4. Clone repo (if not already inside it)
# ---------------------------------------------------------------------------
if [[ -f "package.json" ]] && grep -q "multi-model-analyzer" package.json 2>/dev/null; then
  REPO_DIR="$(pwd)"
  info "Already inside repo at $REPO_DIR"
elif [[ -d "$REPO_DIR/.git" ]]; then
  info "Repo already cloned at $REPO_DIR"
else
  info "Cloning repo to $REPO_DIR..."
  gh repo clone "$GITHUB_USER/multi-model-analyzer" "$REPO_DIR"
fi
cd "$REPO_DIR"

# ---------------------------------------------------------------------------
# 5. System libraries (native deps for SQLite)
# ---------------------------------------------------------------------------
if [[ "$PLATFORM" == "macos" ]]; then
  install_pkg sqlite
elif [[ "$PLATFORM" == "linux" ]]; then
  install_pkg libsqlite3-dev
fi

# ---------------------------------------------------------------------------
# 6. Ollama (local LLM runtime for tier 3 summarization)
# ---------------------------------------------------------------------------
if ! command -v ollama &>/dev/null; then
  info "Installing Ollama..."
  if [[ "$PLATFORM" == "macos" ]]; then
    brew install ollama
  elif [[ "$PLATFORM" == "linux" ]]; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
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
# 7. npm install + build
# ---------------------------------------------------------------------------
info "Installing npm dependencies..."
npm install

info "Building TypeScript..."
npm run build

# ---------------------------------------------------------------------------
# 8. Global npm tools
# ---------------------------------------------------------------------------
GLOBAL_TOOLS=(
  "dependency-cruiser"
  "@sourcegraph/scip-typescript"
)
for tool in "${GLOBAL_TOOLS[@]}"; do
  PKG_NAME="${tool##*/}"
  if ! command -v "$PKG_NAME" &>/dev/null && ! npx --yes "$tool" --version &>/dev/null 2>&1; then
    info "Installing $tool globally..."
    npm install -g "$tool" || warn "Could not install $tool globally -- will use npx at runtime"
  fi
done

# tree-sitter CLI (needed for grammar compilation)
if ! command -v tree-sitter &>/dev/null; then
  info "Installing tree-sitter CLI..."
  if [[ "$PLATFORM" == "macos" ]]; then
    brew install tree-sitter || npm install -g tree-sitter-cli
  else
    npm install -g tree-sitter-cli
  fi
fi

# ---------------------------------------------------------------------------
# 9. Create local data directories + scaffold config
# ---------------------------------------------------------------------------
mkdir -p "$REPO_DIR/data/mirrors"
mkdir -p "$REPO_DIR/data/indexes"

if [[ ! -f "$REPO_DIR/mma.config.json" ]]; then
  cp "$REPO_DIR/mma.config.example.json" "$REPO_DIR/mma.config.json"
  info "Created mma.config.json from example -- edit it to add your target repos"
fi

# ---------------------------------------------------------------------------
# 10. Verify
# ---------------------------------------------------------------------------
info ""
info "============================================"
info " Setup complete"
info "============================================"
info ""
info " Repo:        $REPO_DIR"
info " Platform:    $PLATFORM"
info " Node:        $(node --version)"
info " TypeScript:  $(npx tsc --version)"
info " tree-sitter: $(tree-sitter --version 2>/dev/null || echo 'via npx')"
info " Ollama:      $(ollama --version 2>/dev/null || echo 'installed')"
info ""
info " Next steps:"
info "   1. Create mma.config.json with your target repos (see mma.config.example.json)"
info "   2. Start Ollama:       ollama serve"
info "   3. Run indexing:       npx mma index -v"
info ""
