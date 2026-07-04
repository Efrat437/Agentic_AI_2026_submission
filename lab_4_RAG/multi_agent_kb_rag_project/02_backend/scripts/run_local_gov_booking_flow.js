import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

const hasFlag = (name) => args.includes(name);

const options = {
  fastProbe: hasFlag('--fast-probe'),
  skipProbe: hasFlag('--skip-probe'),
  skipApiBook: hasFlag('--skip-api-book'),
  includeBrowserCli: hasFlag('--include-browser-cli'),
  askOnce: hasFlag('--ask-once') || String(process.env.APPT_ASK_ONCE || 'false').toLowerCase() === 'true',
};

async function runNodeScript(scriptRelativePath, scriptArgs = []) {
  const fullPath = path.resolve(__dirname, scriptRelativePath);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fullPath, ...scriptArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve(0);
      return reject(new Error(`Script failed (${scriptRelativePath}) with exit code ${code}`));
    });
  });
}

async function main() {
  console.log('\n════ local-gov unified booking flow ════');
  console.log(JSON.stringify(options, null, 2));

  if (!options.skipProbe) {
    const probeArgs = [];
    if (options.fastProbe) probeArgs.push('--skip-network');
    await runNodeScript('./run_local_gov_making_operations.js', probeArgs);
  } else {
    console.log('[flow] Skipping making-operations probe (--skip-probe).');
  }

  if (!options.skipApiBook) {
    const apiArgs = [];
    if (options.askOnce) apiArgs.push('--ask-once');
    await runNodeScript('./run_local_gov_api_booking.js', apiArgs);
  } else {
    console.log('[flow] Skipping API booking orchestration (--skip-api-book).');
  }

  if (options.includeBrowserCli) {
    const browserArgs = [];
    if (options.askOnce) browserArgs.push('--ask-once');
    await runNodeScript('./run_local_gov_booking.js', browserArgs);
  }

  console.log('\n✓ Unified local-gov booking flow completed.');
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
