import { ZodError } from "zod";
import { readJsonBody } from "@/lib/server/http";
import { ServerApiError } from "@/lib/server/api-error";
import type { SettingsStore } from "./store";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function createSettingsHandlers(store: SettingsStore) {
  return {
    async GET(): Promise<Response> {
      try {
        return json(await store.get());
      } catch (error) {
        console.error("Unable to load application settings", error);
        return json({ error: "Unable to load application settings" }, 500);
      }
    },

    async PUT(request: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof ServerApiError && error.code === "REQUEST_TOO_LARGE") {
          return json({ error: "Request body is too large" }, 413);
        }
        return json({ error: "Request body must be valid JSON" }, 400);
      }

      try {
        return json(await store.put(body));
      } catch (error) {
        if (error instanceof ZodError) {
          return json({ error: "Invalid settings", issues: error.issues }, 400);
        }
        console.error("Unable to save application settings", error);
        return json({ error: "Unable to save application settings" }, 500);
      }
    },
  };
}
