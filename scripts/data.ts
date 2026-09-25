import { readFile } from "node:fs/promises";
import path from "node:path";
import { showBuildStatus, formatBuildStatus } from "./data-status";
import { readBuildRecipe, buildRelease } from "@/lib/coverage/recipe";
import { writeJsonAtomically } from "@/lib/data/source-cache";
import { exportPreparedRelease, inspectPreparedRelease, type PreparedReleaseOptions } from "@/lib/data/prepared-release";

const [command,...args]=process.argv.slice(2);
const file=args.find(arg=>!arg.startsWith("--"));
process.env.ALPINE_COVERAGE_ROOT ??= ".cache/build";
const statusFile=path.join(process.env.ALPINE_COVERAGE_ROOT,"status.json");
try {
  if(command === "status") {
    await showBuildStatus(file ?? statusFile,args.includes("--watch"));
  } else {
    if(!file) throw new Error("Usage: data <build recipe.json|inspect release.json|export export-options.json|status [report.json] [--watch]>");
    let result:unknown;
    if(command==="build") {
      const controller=new AbortController(), started=Date.now();
      const progress:Parameters<typeof formatBuildStatus>[0]={status:"running",currentStage:"Starting",elapsedMs:0,completedUnits:0};
      let saved=0;
      const save=async()=>{saved=Date.now();progress.elapsedMs=saved-started;await writeJsonAtomically(statusFile,progress);};
      const stop=()=>controller.abort(); process.once("SIGINT",stop); process.once("SIGTERM",stop);
      try {
        await save();
        const built=await buildRelease(await readBuildRecipe(file),{
          signal:controller.signal,
          checkpoint:async()=>{if(Date.now()-saved>=5000) await save();return "continue";},
          report:async update=>{
            progress.currentStage=update.stage ?? progress.currentStage;
            progress.completedUnits=update.completedUnits ?? progress.completedUnits;
            if(update.units) progress.totalUnits=update.units.filter(unit=>unit.status!=="unavailable").length;
            process.stderr.write(`${progress.currentStage}\n`);await save();
          },
        });
        result=built;progress.status=built.status;
      } catch(error) {progress.status=controller.signal.aborted?"paused":"failed";progress.error=error instanceof Error?error.message:String(error);throw error;}
      finally {process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);await save();}
    } else if(command==="inspect") result=await inspectPreparedRelease(file);
    else if(command==="export") result=await exportPreparedRelease(JSON.parse(await readFile(file,"utf8")) as PreparedReleaseOptions);
    else throw new Error(`Unknown data command ${command}`);
    process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }
} catch(error) {process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
