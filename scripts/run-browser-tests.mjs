import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const protectedPaths = ["next-env.d.ts", "tsconfig.json"].map((file) => path.resolve(file));
const originals = new Map(
  await Promise.all(protectedPaths.map(async (file) => [file, await readFile(file)])),
);
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
  await Promise.all([...originals].map(([file, contents]) => writeFile(file, contents)));
}

if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code;
