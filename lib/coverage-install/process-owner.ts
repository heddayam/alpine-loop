import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Process existence alone is insufficient across reboot/container PID reuse. */
export function processBirth(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        if (process.platform === 'linux') {
            const boot = readFileSync(/* turbopackIgnore: true */ '/proc/sys/kernel/random/boot_id', 'utf8').trim();
            const stat = readFileSync(/* turbopackIgnore: true */ `/proc/${pid}/stat`, 'utf8');
            // The command in parentheses may itself contain spaces or parentheses.
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
            const start = fields[19]; // starttime is field 22; fields begins at field 3.
            return boot && start && /^\d+$/.test(start) ? `linux:${boot}:${start}` : null;
        }
        if (process.platform === 'darwin') {
            const options = { encoding: 'utf8' as const, timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } };
            const start = execFileSync(/* turbopackIgnore: true */ '/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
            return start ? `darwin:${start}` : null;
        }
    } catch { /* Unknown identity is handled conservatively by the lease owner. */ }
    return null;
}
