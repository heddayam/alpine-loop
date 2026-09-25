import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("launches only the app, preserving existing settings and reporting Docker failures", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "alpine-launcher-"));
  try {
    mkdirSync(path.join(root, "bin"));
    copyFileSync("alpine.sh", path.join(root, "alpine.sh"));
    writeFileSync(path.join(root, ".env.example"), "DEFAULT=1\n");
    writeFileSync(path.join(root, ".env"), "KEEP=1\n");
    writeFileSync(path.join(root, "bin/docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ALPINE_TEST_CALLS"\nexit "$ALPINE_TEST_EXIT"\n', { mode: 0o755 });
    const run = (code: string) => spawnSync("bash", [path.join(root,"alpine.sh")], { cwd: os.tmpdir(), encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ALPINE_TEST_CALLS: path.join(root,"calls"), ALPINE_TEST_EXIT: code } });
    expect(run("0").status).toBe(0);
    expect(readFileSync(path.join(root,"calls"),"utf8")).toBe("info\ncompose up --build -d app\n");
    expect(readFileSync(path.join(root,".env"),"utf8")).toBe("KEEP=1\n");
    expect(run("1").status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
