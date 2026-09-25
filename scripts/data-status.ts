import { readFile, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Reports are atomic snapshots; old output must not masquerade as a heartbeat. */
export function formatBuildStatus(report: { status: string; currentStage: string; elapsedMs: number; completedUnits: number; totalUnits?: number; error?: string; peakMeasuredMemoryBytes?: number }, updatedAt: number, now = Date.now()) {
  const age = Math.max(0, now - updatedAt);
  const duration = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
  return [
    `Last reported state: ${report.status}`,
    `Phase: ${report.currentStage}`,
    `Elapsed: ${duration(report.elapsedMs + (report.status === "running" ? age : 0))}`,
    `Sections prepared this run: ${report.completedUnits}${report.totalUnits === undefined ? "" : ` / ${report.totalUnits}`}`,
    `Last report: ${duration(age)} ago`,
    ...(report.peakMeasuredMemoryBytes === undefined ? [] : [`Peak process memory: ${Math.ceil(report.peakMeasuredMemoryBytes / 1024 ** 2)} MiB`]),
    ...(report.error ? [`Error: ${report.error}`] : []),
  ].join("\n");
}

export async function showBuildStatus(file: string, watch: boolean) {
  do {
    const report = JSON.parse(await readFile(file, "utf8"));
    const info = await stat(file);
    if (watch && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${formatBuildStatus(report, info.mtimeMs)}\n`);
    if (!watch || report.status !== "running") return;
    process.stdout.write("Watching every 5 seconds. Ctrl+C closes this view, not the build.\n");
    await setTimeout(5000);
  } while (watch);
}
