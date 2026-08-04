import { spawn } from "node:child_process";

export type CommandResult = { stdout: string; stderr: string };

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  options?: { cwd?: string; stdin?: string },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, arguments_, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, [...arguments_], {
    cwd: options.cwd,
    shell: false,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", (error) => reject(new Error(`Unable to execute ${command}: ${error.message}`, { cause: error })));
  child.on("close", (code, signal) => {
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`));
  });
  if (options.stdin !== undefined) child.stdin!.end(options.stdin);
});

export async function requireCommand(command: string, runner: CommandRunner = runCommand): Promise<string> {
  const result = await runner(command, ["--version"]);
  const version = (result.stdout || result.stderr).trim().split("\n")[0];
  if (!version) throw new Error(`${command} did not report a version`);
  return version;
}
