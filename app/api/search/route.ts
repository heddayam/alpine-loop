import { searchRequestSchema, searchResultSchema } from "@/lib/contracts";
import { ServerApiError } from "@/lib/server/api-error";
import { apiFailure, readJsonBody } from "@/lib/server/http";
import { generateSearch } from "@/lib/server/search";

export async function POST(request: Request) {
  try {
    const parsed = searchRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw new ServerApiError("INVALID_REQUEST", "Check the search area and route criteria.", 400);
    return Response.json(searchResultSchema.parse(await generateSearch(parsed.data, request.signal)));
  } catch (error) {
    return apiFailure(error, "The route search failed unexpectedly.");
  }
}
