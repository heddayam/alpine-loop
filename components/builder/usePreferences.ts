"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appSettingsV1Schema, type AppSettingsV1 } from "@/lib/contracts";
import { defaultAppSettings } from "@/lib/settings/defaults";

/** Own the validated preferences and serialize writes of their complete value. */
export function usePreferences() {
  const [settings, setSettings] = useState(defaultAppSettings);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(settings);
  const writes = useRef(Promise.resolve(true));

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Settings could not be loaded.");
        const raw: unknown = await response.json();
        const candidate = raw && typeof raw === "object" && "settings" in raw ? raw.settings : raw;
        const next = appSettingsV1Schema.parse(candidate);
        if (!controller.signal.aborted) {
          current.current = next;
          setSettings(next);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Settings could not be loaded. Using defaults.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true);
      });
    return () => controller.abort();
  }, []);

  const write = useCallback((update: (settings: AppSettingsV1) => AppSettingsV1, immediate: boolean) => {
    const parsed = appSettingsV1Schema.safeParse(update(current.current));
    if (!parsed.success) {
      setError("Settings could not be saved. Check the values and try again.");
      return Promise.resolve(false);
    }
    const next = parsed.data;
    if (immediate) {
      current.current = next;
      setSettings(next);
    }
    const saved = writes.current.then(async () => {
      try {
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!response.ok) throw new Error("Settings could not be saved.");
        if (!immediate) {
          current.current = next;
          setSettings(next);
        }
        setError("");
        return true;
      } catch {
        setError("Settings could not be saved.");
        return false;
      }
    });
    writes.current = saved;
    return saved;
  }, []);

  const change = useCallback((update: (settings: AppSettingsV1) => AppSettingsV1) => write(update, true), [write]);
  const save = useCallback((next: AppSettingsV1) => write(() => next, false), [write]);
  return { settings, loaded, error, change, save };
}
