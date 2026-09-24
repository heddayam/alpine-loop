import * as runtime from "@/lib/coverage/runtime";
import { CoverageJobService, coverageJobDatabasePath } from "./service";

let service: CoverageJobService | undefined;
export function defaultCoverageJobService(): CoverageJobService {
  service ??= new CoverageJobService({ dbPath: coverageJobDatabasePath(), runtime });
  return service;
}
