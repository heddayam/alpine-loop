import { readFile, realpath, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

export type BuildStatus = {
  status: string; currentStage: string; elapsedMs: number; completedUnits: number; totalUnits?: number; error?: string;
  counts?: Record<string, number>; peakMeasuredMemoryBytes?: number; peakCgroupMemoryBytes?: number; peakDiskBytes?: number | null;
  currentStageStartedMs?: number; stageTimings?: {stage:string;elapsedMs:number;durationMs:number}[];
};
/** Reports are atomic snapshots; old output must not masquerade as a heartbeat. */
export function formatBuildStatus(report: BuildStatus, updatedAt: number, now = Date.now()) {
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
    ...(progress ? [`Area preparation: ${progress}`] : []),
    `Last report: ${duration(age)} ago`,
    ...(report.peakMeasuredMemoryBytes === undefined ? [] : [`Peak process memory: ${Math.ceil(report.peakMeasuredMemoryBytes / 1024 ** 2)} MiB`]),
    ...(report.peakCgroupMemoryBytes === undefined ? [] : [`Peak container memory: ${Math.ceil(report.peakCgroupMemoryBytes / 1024 ** 2)} MiB`]),
    ...(report.peakDiskBytes == null ? [] : [`Peak build disk: ${Math.ceil(report.peakDiskBytes / 1024 ** 2)} MiB`]),
    ...Object.entries(report.counts ?? {}).map(([name, count]) => `${name.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase())}: ${count.toLocaleString("en-US")}`),
    ...(report.stageTimings ?? []).map(timing => `${timing.stage}: ${duration(timing.durationMs)}`),
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
