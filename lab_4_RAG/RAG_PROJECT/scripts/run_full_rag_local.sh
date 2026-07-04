#!/usr/bin/env bash
# run_full_rag_local.sh - Linux / macOS
# Usage: bash scripts/run_full_rag_local.sh
set -euo pipefail
ROOT_DIR=$(dirname "$(dirname "$0")")

echo "== Full RAG Local Runner =="

# Check docker
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker and ensure it's running." >&2
  exit 1
fi

# Start chroma container if not running
if ! docker ps --format '{{.Names}}' | grep -q '^chroma-local$'; then
  echo "Starting Chroma container..."
  docker run -d --name chroma-local -p 8000:8000 -v "$PWD/chroma_data:/data" ghcr.io/chroma-core/chroma:latest
else
  echo "Chroma container already running."
fi

# Health check
if curl -sS http://localhost:8000/health >/dev/null 2>&1; then
  echo "Chroma health OK"
else
  echo "Chroma health check failed or starting. Proceeding..."
fi

# Install node deps
pushd "$ROOT_DIR/lab_4_RAG/RAG_PROJECT" >/dev/null
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# Prompt for API keys if not set
: ${OPENROUTER_API_KEY:=""}
: ${OPENAI_API_KEY:=""}
if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  read -p "Enter OPENROUTER_API_KEY (or leave blank to use OPENAI_API_KEY): " key
  if [ -n "$key" ]; then
    export OPENROUTER_API_KEY="$key"
  fi
fi

if [ -z "$LLAMA_PARSE_API_KEY" ]; then
  read -p "Optional: Enter LLAMA_PARSE_API_KEY to enable LLaMA parser (press Enter to skip): " llama
  if [ -n "$llama" ]; then
    export LLAMA_PARSE_API_KEY="$llama"
  fi
fi

export CHROMA_URL=${CHROMA_URL:-http://localhost:8000}

echo "Using CHROMA_URL=$CHROMA_URL"

# Run ingestion test
node 02_scripts/test_ingest_chroma.js
popd >/dev/null
