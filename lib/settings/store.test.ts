import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appSettingsV1Schema } from "@/lib/contracts";
import { defaultAppSettings } from "./defaults";
import { SettingsFileError, SettingsStore } from "./store";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alpine-settings-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SettingsStore", () => {
  it("returns independent defaults when the settings file is missing", async () => {
    const store = new SettingsStore({ rootDirectory: await temporaryRoot() });
    const first = await store.get();
    first.gradePresets.moderate.maximumClimbP90Pct = 99;

    expect(await store.get()).toEqual(defaultAppSettings());
    expect(appSettingsV1Schema.parse(await store.get())).toBeDefined();
  });

  it("writes the full settings atomically and reads them back", async () => {
    const store = new SettingsStore({ rootDirectory: await temporaryRoot() });
    const settings = defaultAppSettings();
    settings.quickSearchRouteCount = 17;
    settings.selectedGradePreset = "steep";

    await expect(store.put(settings)).resolves.toEqual(settings);
    await expect(store.get()).resolves.toEqual(settings);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(settings);
    expect((await readdir(path.dirname(store.filePath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("merges missing schema-1 fields and nested preset values from defaults", async () => {
    const root = await temporaryRoot();
    const filePath = path.join(root, "settings.json");
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      includeUncertainAccess: false,
      accessPointRemoteness: ["rural"],
      quickSearchRouteCount: 4,
      gradePresets: { moderate: { maximumClimbP90Pct: 13 } },
    }));

    const settings = await new SettingsStore({ filePath }).get();
    expect(settings.gradeConstraintEnabled).toBe(false);
    expect(settings.selectedGradePreset).toBe("moderate");
    expect(settings.gradePresets.moderate).toEqual({
      ...defaultAppSettings().gradePresets.moderate,
      maximumClimbP90Pct: 13,
    });
  });

  it("does not silently replace malformed or invalid settings files", async () => {
    const root = await temporaryRoot();
    const malformedPath = path.join(root, "malformed.json");
    const invalidPath = path.join(root, "invalid.json");
    await writeFile(malformedPath, "{");
    await writeFile(invalidPath, JSON.stringify({ ...defaultAppSettings(), quickSearchRouteCount: 99 }));

    await expect(new SettingsStore({ filePath: malformedPath }).get()).rejects.toBeInstanceOf(SettingsFileError);
    await expect(new SettingsStore({ filePath: invalidPath }).get()).rejects.toBeInstanceOf(SettingsFileError);
  });

  it("rejects invalid writes without replacing the last valid file", async () => {
    const store = new SettingsStore({ rootDirectory: await temporaryRoot() });
    const valid = defaultAppSettings();
    await store.put(valid);

    await expect(store.put({ ...valid, quickSearchRouteCount: 21 })).rejects.toThrow();
    await expect(store.get()).resolves.toEqual(valid);
  });
});
