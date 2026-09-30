import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("waits for another connection before initializing the journal mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "coverage-store-startup-"));
  const database = new DatabaseSync(join(root, "downloads.sqlite"));
  database.exec("CREATE TABLE fixture(id INTEGER); BEGIN EXCLUSIVE;");
  let released = false;
  const release = () => { if (!released) { database.exec("COMMIT"); released = true; } };
  const source = pathToFileURL(resolve("lib/coverage-install/store.ts")).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { Store } from ${JSON.stringify(source)};
    process.send('opening');
    const store = new Store(${JSON.stringify(root)});
    store.close();
    process.disconnect();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errors = "";
  child.stderr!.on("data", data => { errors += String(data); });
  child.once("message", () => { timer = setTimeout(release, 100); });
  try {
    const code = await new Promise<number | null>((complete, reject) => {
      child.once("error", reject);
      child.once("exit", complete);
    });
    expect(code, errors).toBe(0);
  } finally {
    clearTimeout(timer);
    release();
    child.kill();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
