const targetPort = Number(process.env.UI_PORT || '5173');

try {
  const net = await import('node:net');
  // no-op import to keep ESM pattern explicit
  void net;
} catch {
  // ignore import issues, script still works through PowerShell fallback path in package scripts
}

// Use PowerShell from Node for reliable Windows process inspection.
import { spawnSync } from 'node:child_process';

const ps = [
  `$c = Get-NetTCPConnection -State Listen -LocalPort ${targetPort} -ErrorAction SilentlyContinue`,
  `if (-not $c) { Write-Host \"No UI listener found on port ${targetPort}\"; exit 0 }`,
  `$pids = $c | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique`,
  `foreach($procId in $pids){`,
  `  try {`,
  `    $proc = Get-Process -Id $procId -ErrorAction Stop`,
  `    if($proc.ProcessName -eq 'node'){ Stop-Process -Id $procId -Force; Write-Host \"Stopped UI node PID $procId\" }`,
  `    else { Write-Host \"Skipping non-node PID $procId ($($proc.ProcessName))\" }`,
  `  } catch { Write-Host \"PID $procId already exited\" }`,
  `}`,
].join('; ');

const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit', shell: false });
process.exit(out.status ?? 0);
