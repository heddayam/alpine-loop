import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const configPath = path.resolve("tsconfig.json");
const originalConfig = await readFile(configPath);
const cliPath = path.resolve("node_modules/@playwright/test/cli.js");
let result = { code: 1, signal: null };

try {
  result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "test", ...process.argv.slice(2)], {
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
} finally {
  await writeFile(configPath, originalConfig);
}

if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code;
