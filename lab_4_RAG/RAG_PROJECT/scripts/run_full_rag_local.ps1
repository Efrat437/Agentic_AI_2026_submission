<#
Run full RAG pipeline locally (PowerShell)
Usage: Open PowerShell as Administrator and run:
  ./scripts/run_full_rag_local.ps1
This script will:
 - Check for Docker
 - Start Chroma container if not running
 - Install Node deps (npm ci)
 - Prompt for required env vars (OPENROUTER_API_KEY or OPENAI_API_KEY)
 - Run the ingestion test: node 02_scripts/test_ingest_chroma.js
#>

param()

function ExitWith($msg,$code=1){ Write-Error $msg; exit $code }

Write-Host "== Full RAG Local Runner ==" -ForegroundColor Cyan

# Check Docker
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    ExitWith "Docker not found. Please install Docker Desktop and ensure 'docker' is in PATH."
}

# Start Chroma container if not running
$container = & docker ps --filter "name=chroma-local" --format "{{.Names}}" 2>$null
if (-not $container) {
    Write-Host "Starting Chroma container..."
    & docker run -d --name chroma-local -p 8000:8000 -v "${PWD}\chroma_data:/data" ghcr.io/chroma-core/chroma:latest | Out-Null
    Start-Sleep -Seconds 3
} else {
    Write-Host "Chroma container already running."
}

# Health check
try {
    $health = curl http://localhost:8000/health -UseBasicParsing -ErrorAction Stop
    Write-Host "Chroma health: $($health.Content)"
} catch {
    Write-Warning "Chroma health check failed. Container may still be starting. Continue anyway."
}

# Install node deps
Write-Host "Installing node dependencies..."
Push-Location "$PSScriptRoot/..\lab_4_RAG\RAG_PROJECT"
if (Test-Path package-lock.json) { npm ci } else { npm install }

# Prompt for API keys
if (-not $env:OPENROUTER_API_KEY -and -not $env:OPENAI_API_KEY) {
    $key = Read-Host "Enter OPENROUTER_API_KEY (or leave blank to use OPENAI_API_KEY instead)"
    if ($key -ne "") { $env:OPENROUTER_API_KEY = $key }
}

if (-not $env:LLAMA_PARSE_API_KEY) {
    $llama = Read-Host "Optional: Enter LLAMA_PARSE_API_KEY to enable LLaMA parser (press Enter to skip)"
    if ($llama -ne "") { $env:LLAMA_PARSE_API_KEY = $llama }
}

# Set CHROMA_URL
$env:CHROMA_URL = $env:CHROMA_URL -or 'http://localhost:8000'
Write-Host "Using CHROMA_URL=$env:CHROMA_URL"

# Run ingestion test
Write-Host "Running full ingestion test..."
node 02_scripts/test_ingest_chroma.js
Pop-Location
