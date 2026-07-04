import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const serverEntry = path.join(projectRoot, '02_backend', 'server.js');
const testScript = path.join(projectRoot, '02_backend', 'scripts', 'test_debug_endpoint.js');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: { ...process.env, PORT: process.env.PORT || '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runTest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [testScript], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const server = startServer();
  let serverReady = false;

  const readinessTimeout = setTimeout(() => {
    if (!serverReady) {
      console.error('[test-debug-endpoint] Server did not start in time.');
      server.kill('SIGTERM');
    }
  }, 20000);

  server.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    if (text.includes('Server listening')) {
      serverReady = true;
    }
  });

  server.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  const serverExitPromise = new Promise((resolve) => {
    server.on('close', (code) => resolve(code ?? 1));
  });

  // Give server time to bind even if startup log comes slightly later.
  const startedAt = Date.now();
  while (!serverReady && Date.now() - startedAt < 25000) {
    await wait(250);
  }

  clearTimeout(readinessTimeout);

  if (!serverReady) {
    const serverExitCode = await serverExitPromise;
    process.exit(serverExitCode || 1);
  }

  const testCode = await runTest();

  server.kill('SIGTERM');
  await Promise.race([
    serverExitPromise,
    wait(5000),
  ]);

  process.exit(testCode);
}

main().catch((err) => {
  console.error('[test-debug-endpoint] Unexpected failure:', err);
  process.exit(1);
});
