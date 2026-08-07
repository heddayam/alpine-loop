import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "./defaults";
import { createSettingsHandlers } from "./http";
import type { SettingsStore } from "./store";

function store(methods: Partial<SettingsStore> = {}): SettingsStore {
  return {
    get: vi.fn(async () => defaultAppSettings()),
    put: vi.fn(async (settings: unknown) => settings),
    ...methods,
  } as unknown as SettingsStore;
}

describe("settings HTTP handlers", () => {
  it("gets and puts the full settings document", async () => {
    const runtime = store();
    const handlers = createSettingsHandlers(runtime);
    const settings = defaultAppSettings();
    settings.gradeConstraintEnabled = true;

    expect(await (await handlers.GET()).json()).toEqual(defaultAppSettings());
    const response = await handlers.PUT(new Request("http://local/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(settings);
    expect(runtime.put).toHaveBeenCalledWith(settings);
  });

  it("rejects malformed JSON and schema-invalid settings", async () => {
    const actualStore = new (await import("./store")).SettingsStore({
      filePath: "/tmp/alpine-settings-http-test-never-written.json",
    });
    const handlers = createSettingsHandlers(actualStore);

    const malformed = await handlers.PUT(new Request("http://local/api/settings", { method: "PUT", body: "{" }));
    expect(malformed.status).toBe(400);

    const invalid = await handlers.PUT(new Request("http://local/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...defaultAppSettings(), quickSearchRouteCount: 100 }),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "Invalid settings" });
  });

  it("does not cache reads and reports storage failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createSettingsHandlers(store({ get: vi.fn(async () => { throw new Error("disk unavailable"); }) }));
    const response = await handlers.GET();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Unable to load application settings" });
    errorSpy.mockRestore();
  });
});
