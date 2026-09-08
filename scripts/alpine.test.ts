import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const up = "\u001b[A";
const down = "\u001b[B";
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function selector(input: string, options: { running?: boolean; fail?: boolean; env?: string } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "alpine-selector-"));
  roots.push(root);
  mkdirSync(path.join(root, "bin"));
  copyFileSync("alpine.sh", path.join(root, "alpine.sh"));
  writeFileSync(path.join(root, ".env.example"), "EXAMPLE=1\n");
  if (options.env) writeFileSync(path.join(root, ".env"), options.env);
  writeFileSync(path.join(root, "bin/docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ALPINE_TEST_CALLS"
case "$*" in
  *'scripts/manage-packs.ts list')
    printf 'central-cascades\\tCentral Cascades\\t1\\t386 MB database\\n'
    printf 'henry-coe\\tHenry Coe\\t0\\t~1.15 GB download\\n' ;;
  'compose ps --status running -q app') [[ "$ALPINE_TEST_RUNNING" == 0 ]] || echo container ;;
  *'scripts/pack-bootstrap.ts'*) [[ "$ALPINE_TEST_FAIL" == 0 ]] || exit 1 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync("bash", [path.join(root, "alpine.sh")], {
    cwd: os.tmpdir(), input, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      ALPINE_TEST_CALLS: path.join(root, "calls"), ALPINE_TEST_RUNNING: options.running ? "1" : "0",
      ALPINE_TEST_FAIL: options.fail ? "1" : "0" },
  });
  return { ...result, root, calls: readFileSync(path.join(root, "calls"), "utf8") };
}

it("installs only additions, preserves settings, and works outside the checkout", () => {
  const result = selector(`${down}\n${down}\n`, { env: "EXISTING=keep\n" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("✓ Central Cascades");
  expect(result.stdout).toContain("○ Henry Coe");
  expect(result.stdout).toContain("✓ Henry Coe (~1.15 GB download) — install");
  expect(result.calls).toContain("scripts/pack-bootstrap.ts --pack=henry-coe --progress");
  expect(result.calls).not.toContain("--pack=central-cascades");
  expect(result.calls).toContain("--interactive=false");
  expect(readFileSync(path.join(result.root, ".env"), "utf8")).toBe("EXISTING=keep\n");
});

it("creates settings once and leaves packs alone when quitting or making no changes", () => {
  for (const input of ["q", `${up}\n`, ""]) {
    const result = selector(input);
    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("scripts/pack-bootstrap.ts");
    expect(result.calls).not.toContain("scripts/manage-packs.ts remove");
    expect(readFileSync(path.join(result.root, ".env"), "utf8")).toBe("EXAMPLE=1\n");
  }
});

it("ignores malformed input and permits toggling back without a build", () => {
  const result = selector(`999999999999999999999999$((1))${down}\n\n${down}\n`);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("› Apply changes");
  expect(result.calls).not.toContain("scripts/pack-bootstrap.ts");
});

it("requires removal confirmation and refuses removal while Docker app is running", () => {
  expect(selector(`\n${up}\nn\n`).calls).not.toContain("scripts/manage-packs.ts remove");
  const running = selector(`\n${up}\ny\n`, { running: true });
  expect(running.status).toBe(1);
  expect(running.stderr).toContain("Stop the app");
  expect(running.calls).not.toContain("scripts/manage-packs.ts remove");
  const confirmed = selector(`\n${up}\ny\n`);
  expect(confirmed.status).toBe(0);
  expect(confirmed.calls).toContain("scripts/manage-packs.ts remove central-cascades");
});

it("does not report success when a pack build fails", () => {
  const result = selector(`${down}\n${down}\n`, { fail: true });
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain("Packs updated.");
});
