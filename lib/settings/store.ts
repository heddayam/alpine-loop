import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { appSettingsV1Schema, type AppSettingsV1 } from "@/lib/contracts";
import { defaultAppSettings } from "./defaults";

export const DEFAULT_SETTINGS_RELATIVE_PATH = path.join(".local-data", "runtime", "settings.json");

export interface SettingsStoreOptions {
  /** Exact file path. Takes precedence over rootDirectory. */
  filePath?: string;
  /** Root under which .local-data/runtime/settings.json is stored. */
  rootDirectory?: string;
}

export class SettingsFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds fields introduced by compatible schema-1 upgrades while retaining strict
 * validation for values that are present in the file.
 */
function mergeWithDefaults(value: unknown): unknown {
  if (!isRecord(value)) return value;

  const defaults = defaultAppSettings();
  const presets = isRecord(value.gradePresets) ? value.gradePresets : {};
  return {
    ...defaults,
    ...value,
    gradePresets: {
      gentle: {
        ...defaults.gradePresets.gentle,
        ...(isRecord(presets.gentle) ? presets.gentle : {}),
      },
      moderate: {
        ...defaults.gradePresets.moderate,
        ...(isRecord(presets.moderate) ? presets.moderate : {}),
      },
      steep: {
        ...defaults.gradePresets.steep,
        ...(isRecord(presets.steep) ? presets.steep : {}),
      },
    },
  };
}

export class SettingsStore {
  readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: SettingsStoreOptions = {}) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : path.resolve(options.rootDirectory ?? process.cwd(), DEFAULT_SETTINGS_RELATIVE_PATH);
  }

  async get(): Promise<AppSettingsV1> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultAppSettings();
      throw new SettingsFileError(`Unable to read settings from ${this.filePath}`, { cause: error });
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(source) as unknown;
    } catch (error) {
      throw new SettingsFileError(`Settings file ${this.filePath} is not valid JSON`, { cause: error });
    }

    const parsed = appSettingsV1Schema.safeParse(mergeWithDefaults(decoded));
    if (!parsed.success) {
      throw new SettingsFileError(`Settings file ${this.filePath} does not match schema version 1`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async put(value: unknown): Promise<AppSettingsV1> {
    const settings = appSettingsV1Schema.parse(value);
    const operation = this.pendingWrite.then(() => this.writeAtomically(settings));
    this.pendingWrite = operation.catch(() => undefined);
    await operation;
    return structuredClone(settings);
  }

  private async writeAtomically(settings: AppSettingsV1): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new SettingsFileError(`Unable to write settings to ${this.filePath}`, { cause: error });
    }
  }
}
