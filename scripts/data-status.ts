import { readFile, realpath, stat } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

/** Reports are atomic snapshots; old output must not masquerade as a heartbeat. */
export function formatBuildStatus(report: { status: string; currentStage: string; elapsedMs: number; completedUnits: number; totalUnits?: number; error?: string; peakMeasuredMemoryBytes?: number; currentStageStartedMs?: number; stageTimings?: {stage:string;elapsedMs:number;durationMs:number}[] }, updatedAt: number, now = Date.now()) {
  const age = Math.max(0, now - updatedAt);
  const duration = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
  const total=report.totalUnits, remaining=total === undefined ? undefined : Math.max(0,total-report.completedUnits);
  const history=report.stageTimings ?? [];
  const preparing=/^(Preparing installation unit|Prepared q-)/.test(report.currentStage);
  const completedAt=history.filter(item=>/^Prepared q-/.test(item.stage)).map(item=>item.elapsedMs);
  if(/^Prepared q-/.test(report.currentStage)) completedAt.push(report.currentStageStartedMs ?? report.elapsedMs);
  const rates=completedAt.slice(1).map((time,index)=>time-completedAt[index]!).slice(-12).sort((a,b)=>a-b);
  const estimate=preparing && remaining && rates.length>=5 && age<=Math.max(60000,rates.at(-1)!)*2
    ? `Section ETA at recent rate: ~${duration(rates[Math.floor(rates.length*.25)]!*remaining)}–${duration(rates[Math.floor(rates.length*.9)]!*remaining)} (rough; finalization excluded)`
    : "ETA: unavailable until the current work establishes a representative rate";
  const sections=total === undefined ? `${report.completedUnits}` : `${report.completedUnits} / ${total} (${Math.floor(report.completedUnits/Math.max(1,total)*100)}%) · ${remaining} remaining`;
  return [
    `Last reported state: ${report.status}`,
    `Phase: ${report.currentStage}`,
    `Elapsed: ${duration(report.elapsedMs + (report.status === "running" ? age : 0))}`,
    `Section preparation: ${sections}`,
    ...(report.status === "running" ? [
      `Source verification: ${report.completedUnits || report.currentStage.startsWith("Classifying") || history.some(item=>item.stage.startsWith("Classifying")) ? "done" : "in progress"}`,
      `Coverage classification: ${report.completedUnits || preparing ? "done" : "pending / in progress"}`,
      `Graph finalization, audit and export: ${remaining === 0 ? "in progress" : "pending"}`,
      estimate,
    ] : []),
    `Last report: ${duration(age)} ago`,
    ...(report.peakMeasuredMemoryBytes === undefined ? [] : [`Peak process memory: ${Math.ceil(report.peakMeasuredMemoryBytes / 1024 ** 2)} MiB`]),
    ...(report.error ? [`Error: ${report.error}`] : []),
  ].join("\n");
}

export async function showBuildStatus(file: string, watch: boolean) {
  do {
    const resolved=await realpath(file);
    const report = JSON.parse(await readFile(resolved, "utf8"));
    // Context supplies a known total for older build reports, without touching the writer.
    try {
      const context=JSON.parse(await readFile(resolved.replace(/\.json$/, ".context.json"),"utf8"));
      report.totalUnits ??= context.totalUnits;
    } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
    const info = await stat(resolved);
    if (watch && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${formatBuildStatus(report, info.mtimeMs)}\n`);
    if (!watch || report.status !== "running") return;
    process.stdout.write("Watching every 5 seconds. Ctrl+C closes this view, not the build.\n");
    await setTimeout(5000);
  } while (watch);
}
