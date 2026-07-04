#!/usr/bin/env bash
# deploy_chroma_on_vm.sh
# Run on the VM after SSHing in (ubuntu user on Ubuntu AMI)
# Usage on VM:
#   sudo bash deploy_chroma_on_vm.sh <your-git-repo-url>

set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <git-repo-url>"
  exit 1
fi

REPO_URL="$1"
WORKDIR=/opt/agentic_ai

apt update
apt install -y git curl nodejs npm

# Ensure Docker is running; if not, install it
if ! command -v docker >/dev/null 2>&1; then
  apt install -y docker.io
  systemctl enable --now docker
fi

# Clone repository
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

if [ -d ".git" ]; then
  git pull
else
  git clone "$REPO_URL" .
fi

# Install Node deps (may take time)
cd lab_4_RAG/RAG_PROJECT || exit 1
npm ci || npm install

# Export CHROMA_URL to use local container
export CHROMA_URL="http://localhost:8000"

# Optionally export API keys here
# export OPENROUTER_API_KEY="..."
# export OPENAI_API_KEY="..."
# export LLAMA_PARSE_API_KEY="..."

# Run ingestion
node 02_scripts/test_ingest_chroma.js

# After this you can run node index.js or other scripts as needed
