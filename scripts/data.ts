import { readFile } from "node:fs/promises";
import { readBuildRecipe, buildRelease } from "@/lib/coverage/recipe";
import { exportPreparedRelease, inspectPreparedRelease, type PreparedReleaseOptions } from "@/lib/data/prepared-release";

const [command,file]=process.argv.slice(2);
try {
  if(!file) throw new Error("Usage: data <build recipe.json|inspect release.json|export export-options.json>");
  const input=JSON.parse(await readFile(file,"utf8"));
  let result:unknown;
  if(command==="build") {
    const controller=new AbortController();
    const stop=()=>controller.abort(); process.once("SIGINT",stop); process.once("SIGTERM",stop);
    try {result=await buildRelease(await readBuildRecipe(file),{signal:controller.signal,checkpoint:async()=>"continue",report:async update=>{process.stderr.write(`${update.stage ?? "Building"}\n`);}});}
    finally {process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
  } else if(command==="inspect") result=await inspectPreparedRelease(file);
  else if(command==="export") result=await exportPreparedRelease(input as PreparedReleaseOptions);
  else throw new Error(`Unknown data command ${command}`);
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
} catch(error) {process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
