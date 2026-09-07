import { apiFailure } from "@/lib/server/http";
import { mapData } from "@/lib/server/map";

export async function GET(request: Request) {
  try { return Response.json(await mapData(request)); }
  catch (error) { return apiFailure(error, "Map data could not be loaded."); }
}
