import { searchCatalogSchema } from "@/lib/contracts";
import { apiFailure } from "@/lib/server/http";
import { searchCatalog } from "@/lib/server/search-area";

export async function GET() {
  try { return Response.json(searchCatalogSchema.parse(await searchCatalog())); }
  catch (error) { return apiFailure(error, "Available search areas could not be loaded."); }
}
