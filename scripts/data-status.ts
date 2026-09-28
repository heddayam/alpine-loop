import { readFile, realpath, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Reports are atomic snapshots; old output must not masquerade as a heartbeat. */
export function formatBuildStatus(report: { status: string; currentStage: string; elapsedMs: number; completedUnits: number; totalUnits?: number; error?: string; peakMeasuredMemoryBytes?: number; currentStageStartedMs?: number; stageTimings?: {stage:string;elapsedMs:number;durationMs:number}[] }, updatedAt: number, now = Date.now()) {
  const age = Math.max(0, now - updatedAt);
  const duration = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
  const total = report.totalUnits;
  const progress = total !== undefined && total > 0
    ? `${report.completedUnits} / ${total} · ${Math.max(0, total - report.completedUnits)} remaining`
    : null;
  return [
    `Last reported state: ${report.status}`,
    `Phase: ${report.currentStage}`,
    `Elapsed: ${duration(report.elapsedMs + (report.status === "running" ? age : 0))}`,
    ...(progress ? [`Network preparation: ${progress}`] : []),
    `Last report: ${duration(age)} ago`,
    ...(report.peakMeasuredMemoryBytes === undefined ? [] : [`Peak process memory: ${Math.ceil(report.peakMeasuredMemoryBytes / 1024 ** 2)} MiB`]),
    ...(report.error ? [`Error: ${report.error}`] : []),
  ].join("\n");
}

export async function showBuildStatus(file: string, watch: boolean) {
  do {
    const resolved=await realpath(file);
    const report = JSON.parse(await readFile(resolved, "utf8"));
    const info = await stat(resolved);
    if (watch && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${formatBuildStatus(report, info.mtimeMs)}\n`);
    if (!watch || report.status !== "running") return;
    process.stdout.write("Watching every 5 seconds. Ctrl+C closes this view, not the build.\n");
    await setTimeout(5000);
  } while (watch);
}
