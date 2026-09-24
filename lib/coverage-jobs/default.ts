import { catalog, plan } from "@/lib/coverage/planning";
import { CoverageJobService, coverageJobDatabasePath } from "./service";

let service: CoverageJobService | undefined;
export function defaultCoverageJobService(): CoverageJobService {
  service ??= new CoverageJobService({ dbPath: coverageJobDatabasePath(), runtime: { catalog, plan } });
  return service;
}
