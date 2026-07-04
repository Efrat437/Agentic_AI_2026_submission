#!/usr/bin/env node
// scripts/check_env_and_ports.js
// Robust environment and port check for RAG pipeline

import { execSync, spawnSync } from 'child_process';
import net from 'net';

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.warn('[WARN] Docker daemon is not reachable right now. Continuing and validating DB accessibility directly.');
    return false;
  }
}

async function waitForDatabase(port = 5433, maxWait = 60) {
  let waited = 0;
  const host = 'localhost';
  
  while (waited < maxWait) {
    try {
      const socket = net.createConnection({ port, host, timeout: 2000 });
      const isConnected = await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => resolve(false));
        setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 2000);
      });
      
      if (isConnected) return true;
    } catch (e) {
      // ignore
    }
    
    process.stdout.write('.');
    waited++;
    await new Promise(res => setTimeout(res, 1000));
  }
  console.error(`\n[ERROR] Database port ${port} not accessible in ${maxWait} seconds.`);
  process.exit(1);
}

function freePort(port) {
  try {
    const res = spawnSync('powershell', [
      '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
    ]);
    if (res.error) throw res.error;
  } catch (e) {
    // ignore
  }
}

function checkAndFreePorts(ports) {
  ports.forEach(port => {
    const server = net.createServer();
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[INFO] Port ${port} in use. Attempting to free...`);
        freePort(port);
      }
    });
    server.once('listening', () => {
      server.close();
    });
    server.listen(port, '127.0.0.1');
  });
}

function parsePortsFromEnv(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0 && v <= 65535);
}

// MAIN
const main = async () => {
  const dockerOk = checkDocker();
  if (dockerOk) {
    console.log('[INFO] Docker is running.');
  }

  const dbPort = parseInt(process.env.DB_PORT || '5433', 10);
  console.log(`[INFO] Waiting for database on port ${dbPort} to be accessible...`);
  await waitForDatabase(dbPort, 90);
  console.log('\n[INFO] Database is accessible.');

  // Use env or fallback for ports
  const backendPort = parseInt(process.env.BACKEND_PORT || '3000', 10);
  const frontendPort = parseInt(process.env.FRONTEND_PORT || '5173', 10);
  const envPorts = parsePortsFromEnv(process.env.PORTS_TO_CHECK);
  const portsToCheck = envPorts.length ? envPorts : [backendPort, frontendPort];
  console.log(`[INFO] Checking and freeing ports (${portsToCheck.join(', ')})...`);
  checkAndFreePorts(portsToCheck);
  console.log('[INFO] Ports checked.');

  console.log('[INFO] Environment and ports are ready.');
  process.exit(0);
};
main();
