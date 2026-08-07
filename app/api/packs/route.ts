import { loadPackCatalog } from "@/lib/packs/pack-catalog";

export async function GET(): Promise<Response> {
  return Response.json(await loadPackCatalog());
}
