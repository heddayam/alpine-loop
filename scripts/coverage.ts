import { readFile } from "node:fs/promises";
import { coverageRequestSchema } from "@/lib/contracts/coverage";
import { defaultCoverageJobService } from "@/lib/coverage-jobs/default";
import { cleanupCoverageGenerations } from "@/lib/coverage/retention";

const [command, argument] = process.argv.slice(2);
let service: ReturnType<typeof defaultCoverageJobService> | undefined;
const jobs = () => service ??= defaultCoverageJobService();
try {
  let result: unknown;
  switch (command) {
    case "catalog": result = await jobs().catalog(); break;
    case "plan": {
      if (!argument) throw new Error("Usage: coverage plan <request.json>");
      const request = coverageRequestSchema.parse(JSON.parse(await readFile(argument,"utf8")));
      result = await jobs().plan(request);
      break;
    }
    case "build": {
      if (!argument) throw new Error("Usage: coverage build <plan-id>");
      result = jobs().build(argument);
      break;
    }
    case "status": result = argument ? jobs().get(argument) : jobs().list(); break;
    case "cleanup": {
      if (argument && argument !== "--delete") throw new Error("Usage: coverage cleanup [--delete]");
      result = await cleanupCoverageGenerations({ deleteEligible: argument === "--delete" });
      break;
    }
    case "pause": case "resume": case "cancel": case "publish": {
      if (!argument) throw new Error(`Usage: coverage ${command} <job-id>`);
      result = jobs().action(argument, command);
      break;
    }
    default: throw new Error("Usage: coverage <catalog|plan|build|status|pause|resume|cancel|publish|cleanup> [argument]");
  }
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  service?.close();
}
