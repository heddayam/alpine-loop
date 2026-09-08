import { writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPackAuditPassed, auditSqlitePack, type RegionalPackAudit } from "./audit";
import { compilePack, type CompilePackOptions } from "./compiler";
import type { PackBuildResult } from "./types";

/** Audits the completed artifact and writes its reports before activation. */
export async function compileAuditedPack(
  options: CompilePackOptions,
  reports: (artifact: PackBuildResult) => Record<string, unknown>,
  onProgress?: (label: string) => void,
): Promise<{ pack: PackBuildResult; regionalAudit: RegionalPackAudit }> {
  let regionalAudit!: RegionalPackAudit;
  const pack = await compilePack({
    ...options,
    beforePublish: async (artifact) => {
      await options.beforePublish?.(artifact);
      regionalAudit = await auditSqlitePack({ ...artifact, onProgress });
      assertPackAuditPassed(regionalAudit);
      onProgress?.("Write regional reports");
      await Promise.all(Object.entries({
        ...reports(artifact),
        "regional-audit.json": regionalAudit,
      }).map(([filename, report]) => writeFile(
        path.join(artifact.packDirectory, filename),
        `${JSON.stringify(report, null, 2)}\n`,
      )));
    },
  });
  return { pack, regionalAudit };
}
