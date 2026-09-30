import type { RouteJobV2 } from "@/lib/contracts/search";

export function isImprovingResults(job: RouteJobV2) {
  const progress = job.progress;
  return job.status === "running" && ((progress.searchPass ?? 1) > 1 || (
    progress.eligibleAccessPointCount > 0 &&
    progress.processedAccessPointCount >= progress.eligibleAccessPointCount &&
    (progress.unfinishedAccessPointCount ?? 0) > 0
  ));
}

export function jobStatusLabel(job: RouteJobV2) {
  if (isImprovingResults(job)) return "Improving results";
  if (job.status === "cancelled") return "Stopped";
  if (job.status === "completed" && (job.progress.limitedAccessPointCount ?? 0) > 0) return "Completed with limits";
  return { queued: "Queued", "resolving-drive-time": "Resolving drive time", running: "Running", completed: "Completed", failed: "Failed", deleting: "Deleting" }[job.status];
}

export function jobStage(job: RouteJobV2) {
  const { processedAccessPointCount: processed, eligibleAccessPointCount: eligible, searchPass, exhaustedAccessPointCount: exhausted, unfinishedAccessPointCount: unfinished, limitedAccessPointCount: limited } = job.progress;
  switch (job.status) {
    case "queued": return "Waiting in queue.";
    case "resolving-drive-time": return "Calculating the drive-time area.";
    case "running": return isImprovingResults(job)
      ? `Improving results${searchPass ? ` — pass ${searchPass}` : ""}.`
      : eligible ? `Searching trailheads — ${processed} of ${eligible} attempted.` : "Finding eligible trailheads.";
    case "completed": return (limited ?? 0) > 0 || (unfinished ?? 0) > 0
      ? "Search finished with unexplored possibilities. More suitable routes may exist."
      : exhausted === eligible && unfinished === 0 && limited === 0
        ? "Exact search complete for every eligible trailhead."
        : processed >= eligible ? "All eligible trailheads were attempted." : `${processed} of ${eligible} trailheads attempted.`;
    case "cancelled": return eligible ? `Stopped after ${processed} of ${eligible} trailheads were attempted.` : "Search stopped before trailhead processing began.";
    case "failed": return "Stopped with an error.";
    case "deleting": return "Removing this job and its saved routes.";
  }
}

/** Missing historical counters stay unknown, rather than becoming zero. */
export function explorationSummary(job: RouteJobV2) {
  const { exhaustedAccessPointCount, unfinishedAccessPointCount, limitedAccessPointCount } = job.progress;
  const counts = [
    exhaustedAccessPointCount === undefined ? null : `${exhaustedAccessPointCount} exact search${exhaustedAccessPointCount === 1 ? "" : "es"} complete`,
    unfinishedAccessPointCount === undefined ? null : `${unfinishedAccessPointCount} unfinished`,
    limitedAccessPointCount === undefined ? null : `${limitedAccessPointCount} at search limits`,
  ].filter(Boolean);
  return counts.length ? `Trailhead searches: ${counts.join(" · ")}.` : null;
}
