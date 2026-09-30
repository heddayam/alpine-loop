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
for argument do final_argument="$argument"; done
if [ "$final_argument" = regions ] && [ "$ALPINE_TEST_COMPOSE_EXIT" = 0 ]; then
  printf 'central-cascades\\tCentral Cascades\\nnorth-cascades\\tNorth Cascades\\nissaquah-alps\\tIssaquah Alps\\n'
fi
exit "$ALPINE_TEST_COMPOSE_EXIT"
`, { mode: 0o755 });
  const environment = (overrides: Record<string, string> = {}) => ({
    ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
    ALPINE_SOURCE_CACHE: "", ALPINE_TEST_CALLS: callsPath,
    ALPINE_TEST_INFO_EXIT: "0", ALPINE_TEST_COMPOSE_EXIT: "0", ...overrides,
  });
  return {
    root,
    run: (args: string[] = [], overrides: Record<string, string> = {}) => spawnSync("bash", [path.join(root, "alpine.sh"), ...args], {
      cwd: os.tmpdir(), encoding: "utf8", timeout: 10000,
      env: environment(overrides),
    }),
    runInteractive: (input: string, overrides: Record<string, string> = {}) => {
      const launcher = path.join(root, "alpine.sh");
      const terminalCommand = path.join(root, "terminal-command");
      const completionPath = path.join(root, "terminal-complete");
      writeFileSync(terminalCommand, 'bash "$1"\nstatus=$?\n: > "$2"\nexit "$status"\n');
      const command = ["bash", terminalCommand, launcher, completionPath];
      // Both script variants return the child status with -e; use a real PTY
      // so the launcher's terminal detection remains part of this test.
      const args = os.platform() === "linux"
        ? ["-q", "-e", "-c", command.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" "), "/dev/null"]
        : ["-q", "-e", "/dev/null", ...command];
      const inputPath = path.join(root, "terminal-input");
      writeFileSync(inputPath, input);
      // BSD script rejects Node's socket-based stdin with ENOTSUP. Bash
      // supplies a Unix pipe instead. Keep it open until the child finishes
      // to avoid script injecting EOF before buffered input reaches read.
      const feedInput = 'set -o pipefail; { cat "$1"; deadline=$((SECONDS + 5)); while [[ ! -e "$2" ]] && (( SECONDS < deadline )); do sleep 0.01; done; } | script "${@:3}"';
      return spawnSync("bash", ["-c", feedInput, "alpine-pty-test", inputPath, completionPath, ...args], {
        cwd: os.tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
        env: environment(overrides),
      });
    },
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

it("starts the app only with its explicit command and preserves settings", () => {
  withLauncher(({ root, run, calls }) => {
    writeFileSync(path.join(root, ".env"), "KEEP=1\n");
    const result = run(["app"]);
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
    expect(run(["app"]).status).toBe(0);
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

it.each([[], ["help"], ["--help"], ["-h"]])("prints help for noninteractive %j without side effects", (...args) => {
  withLauncher(({ root, run, calls }) => {
    const result = run(args);
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

it.each([["app"], ["build", "north-cascades"]])("propagates Compose failure for %j without reporting success", (...args) => {
  withLauncher(({ run }) => {
    const result = run(args, { ALPINE_TEST_COMPOSE_EXIT: "17" });
    expect(result.status).toBe(17);
    expect(result.stdout).not.toContain("Alpine Loop is running");
  });
});

it("lets a terminal user preview comma-separated areas with the source cache override", () => {
  withLauncher(({ runInteractive, calls }) => {
    const cache = "/app/.cache/source cache";
    const result = runInteractive("2,1\np\n", { ALPINE_SOURCE_CACHE: cache });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const prefix = ["compose", "run", "--rm", "--build", "-e", `ALPINE_SOURCE_CACHE=${cache}`, "data", "scripts/data.ts"];
    expect(calls(), result.stdout).toEqual([
      ["info"], [...prefix, "regions"], [...prefix, "plan", "north-cascades", "central-cascades"],
    ]);
    expect(result.stdout).toContain("Central Cascades");
    expect(result.stdout).toContain("North Cascades");
    expect(result.stdout).not.toContain("Alpine Loop is running");
  });
});

it("builds all areas only after the terminal user selects the build action", () => {
  withLauncher(({ runInteractive, calls }) => {
    const result = runInteractive("all\nbuild\n");
    expect(result.status).toBe(0);
    const prefix = ["compose", "run", "--rm", "--build", "data", "scripts/data.ts"];
    expect(calls()).toEqual([
      ["info"], [...prefix, "regions"],
      [...prefix, "build", "central-cascades", "north-cascades", "issaquah-alps"],
    ]);
    expect(result.stdout).not.toContain("Alpine Loop is running");
  });
});

it("defaults an interactive area action to preview on Enter", () => {
  withLauncher(({ runInteractive, calls }) => {
    expect(runInteractive("1 3\n\n").status).toBe(0);
    expect(calls()).toEqual([
      ["info"], ["compose", "run", "--rm", "--build", "data", "scripts/data.ts", "regions"],
      ["compose", "run", "--rm", "--build", "data", "scripts/data.ts", "plan", "central-cascades", "issaquah-alps"],
    ]);
  });
});

it.each(["\n", "q\n", "1\nq\n"])("quits the area chooser for %j without a plan, build or app start", (input) => {
  withLauncher(({ runInteractive, calls }) => {
    expect(runInteractive(input).status).toBe(0);
    expect(calls()).toEqual([
      ["info"], ["compose", "run", "--rm", "--build", "data", "scripts/data.ts", "regions"],
    ]);
  });
});

it.each(["4\n", "1 1\n", "north-cascades\n"])("rejects invalid interactive selection %j before a build", (input) => {
  withLauncher(({ runInteractive, calls }) => {
    expect(runInteractive(input).status).not.toBe(0);
    expect(calls()).toEqual([
      ["info"], ["compose", "run", "--rm", "--build", "data", "scripts/data.ts", "regions"],
    ]);
  });
});
