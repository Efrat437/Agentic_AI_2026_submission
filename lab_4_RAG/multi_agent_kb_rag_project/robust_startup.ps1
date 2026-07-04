# Robust startup script for RAG project (Windows PowerShell)
# 1. Ensure Docker Desktop is running
# 2. Start containers and wait for Postgres
# 3. Run all DB and backend scripts in order
# 4. Start backend and frontend
# 5. Test /ask endpoint for a valid response

$ErrorActionPreference = 'Stop'

function Wait-ForPort {
    param(
        [int]$Port,
        [int]$TimeoutSec = 60
    )
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        try {
            $tcp = New-Object Net.Sockets.TcpClient('127.0.0.1', $Port)
            $tcp.Close()
            return $true
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    throw "Timeout waiting for port $Port to be open."
}

Write-Host "[1/6] Checking Docker Desktop..."
docker info | Out-Null
Write-Host "Docker is running."

Write-Host "[2/6] Starting containers..."
docker compose up -d

Write-Host "[3/6] Waiting for Postgres on port 5433..."
Wait-ForPort -Port 5433 -TimeoutSec 90
Write-Host "Postgres is up."

Write-Host "[4/6] Running DB and embedding scripts..."
npm run db:create-tables
npm run db:load-data
npm run db:ensure-sql-tables
npm run db:embed

Write-Host "[5/6] Starting backend..."
# Kill any process using 3000 or 4000
Get-Process -Id (Get-NetTCPConnection -LocalPort 3000,4000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
npm run backend:start

Write-Host "[6/6] Starting frontend..."
# Kill any process using 5173
Get-Process -Id (Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
npm run frontend:start

Write-Host "[Test] Testing /ask endpoint..."
$response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/ask" -Method Post -Body '{"query": "What is RAG?"}' -ContentType "application/json" -ErrorAction SilentlyContinue
Write-Host "Response from /ask:"
$response | ConvertTo-Json -Depth 5
