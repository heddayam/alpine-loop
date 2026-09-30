import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

function withLauncher(check: (fixture: ReturnType<typeof createLauncher>) => void) {
  const fixture = createLauncher();
  try { check(fixture); }
  finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

function createLauncher() {
  const root = mkdtempSync(path.join(os.tmpdir(), "alpine-launcher-"));
  const callsPath = path.join(root, "calls");
  mkdirSync(path.join(root, "bin"));
  copyFileSync("alpine.sh", path.join(root, "alpine.sh"));
  writeFileSync(path.join(root, ".env.example"), "DEFAULT=1\n");
  // Record each argument separately, including whitespace and empty arguments.
  writeFileSync(path.join(root, "bin/docker"), `#!/bin/sh
printf '%s\\0' "$#" "$@" >> "$ALPINE_TEST_CALLS"
if [ "$1" = info ]; then exit "$ALPINE_TEST_INFO_EXIT"; fi
exit "$ALPINE_TEST_COMPOSE_EXIT"
`, { mode: 0o755 });
  return {
    root,
    run: (args: string[] = [], overrides: Record<string, string> = {}) => spawnSync("bash", [path.join(root, "alpine.sh"), ...args], {
      cwd: os.tmpdir(), encoding: "utf8", timeout: 10000,
      env: {
        ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        ALPINE_SOURCE_CACHE: "", ALPINE_TEST_CALLS: callsPath,
        ALPINE_TEST_INFO_EXIT: "0", ALPINE_TEST_COMPOSE_EXIT: "0", ...overrides,
      },
    }),
    calls: () => {
      if (!existsSync(callsPath)) return [];
      const fields = readFileSync(callsPath, "utf8").split("\0");
      const calls: string[][] = [];
      for (let index = 0; index < fields.length - 1;) {
        const count = Number(fields[index++]);
        calls.push(fields.slice(index, index + count));
        index += count;
      }
      return calls;
    },
  };
}

it.each([[], ["app"]])("starts the app with %j and preserves existing settings", (...args) => {
  withLauncher(({ root, run, calls }) => {
    writeFileSync(path.join(root, ".env"), "KEEP=1\n");
    const result = run(args);
    expect(result.status).toBe(0);
    expect(calls()).toEqual([["info"], ["compose", "up", "--build", "-d", "app"]]);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("KEEP=1\n");
    expect(existsSync(path.join(root, ".local-data/releases"))).toBe(true);
    expect(existsSync(path.join(root, ".cache"))).toBe(false);
    expect(result.stdout).toContain("Alpine Loop is running");
  });
});

it("creates initial settings when launching a new checkout", () => {
  withLauncher(({ root, run }) => {
    expect(run().status).toBe(0);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("DEFAULT=1\n");
  });
});

it.each([
  ["regions"],
  ["plan", "north-cascades", "central-cascades"],
  ["build", "snoqualmie-region", "issaquah-alps", "--rebuild"],
  ["status"],
  ["status", "report with spaces.json", "--watch"],
])("runs only the data tooling for %j", (...args) => {
  withLauncher(({ root, run, calls }) => {
    const result = run(args);
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      ["info"], ["compose", "run", "--rm", "--build", "data", "scripts/data.ts", ...args],
    ]);
    expect(existsSync(path.join(root, ".cache"))).toBe(true);
    expect(existsSync(path.join(root, ".local-data/releases"))).toBe(true);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("DEFAULT=1\n");
    expect(result.stdout).not.toContain("Alpine Loop is running");
  });
});

it("preserves quoted data arguments and forwards an explicit source cache", () => {
  withLauncher(({ run, calls }) => {
    const args = ["build", "a region; $(touch unexpected)", "--rebuild"];
    const cache = "/app/.cache/source cache/$literal";
    expect(run(args, { ALPINE_SOURCE_CACHE: cache }).status).toBe(0);
    expect(calls()).toEqual([
      ["info"], ["compose", "run", "--rm", "--build", "-e", `ALPINE_SOURCE_CACHE=${cache}`, "data", "scripts/data.ts", ...args],
    ]);
  });
});

it.each(["help", "--help", "-h"])("prints %s without touching Docker, settings or data directories", (command) => {
  withLauncher(({ root, run, calls }) => {
    const result = run([command]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ./alpine.sh");
    expect(result.stdout).toContain("build REGION");
    expect(calls()).toEqual([]);
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(existsSync(path.join(root, ".local-data"))).toBe(false);
    expect(existsSync(path.join(root, ".cache"))).toBe(false);
  });
});

it.each([
  ["unknown"], ["app", "north-cascades"], ["regions", "extra"],
  ["plan"], ["build"], ["build", "--rebuild"], ["plan", "--unknown"],
])("rejects incomplete or unknown dispatch %j before side effects", (...args) => {
  withLauncher(({ root, run, calls }) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: ./alpine.sh");
    expect(calls()).toEqual([]);
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(existsSync(path.join(root, ".local-data"))).toBe(false);
    expect(existsSync(path.join(root, ".cache"))).toBe(false);
  });
});

it("leaves detailed region and option validation to the data CLI", () => {
  withLauncher(({ run, calls }) => {
    const args = ["build", "unknown-region", "--unknown-option"];
    expect(run(args).status).toBe(0);
    expect(calls()[1]).toEqual(["compose", "run", "--rm", "--build", "data", "scripts/data.ts", ...args]);
  });
});

it("stops before initialization when Docker is unavailable", () => {
  withLauncher(({ root, run, calls }) => {
    const result = run(["build", "north-cascades"], { ALPINE_TEST_INFO_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Start Docker");
    expect(result.stdout).not.toContain("Alpine Loop is running");
    expect(calls()).toEqual([["info"]]);
    expect(existsSync(path.join(root, ".env"))).toBe(false);
    expect(existsSync(path.join(root, ".local-data"))).toBe(false);
  });
});

it.each([[], ["build", "north-cascades"]])("propagates Compose failure for %j without reporting success", (...args) => {
  withLauncher(({ run }) => {
    const result = run(args, { ALPINE_TEST_COMPOSE_EXIT: "17" });
    expect(result.status).toBe(17);
    expect(result.stdout).not.toContain("Alpine Loop is running");
  });
});
