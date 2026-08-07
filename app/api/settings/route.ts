import { createSettingsHandlers, SettingsStore } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const store = new SettingsStore();

export async function GET(): Promise<Response> {
  return createSettingsHandlers(store).GET();
}

export async function PUT(request: Request): Promise<Response> {
  return createSettingsHandlers(store).PUT(request);
}
