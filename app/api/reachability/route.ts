import { defaultReachabilityService } from "@/lib/reachability/default-service";
import { createReachabilitySubmitHandler } from "@/lib/reachability/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createReachabilitySubmitHandler(defaultReachabilityService());
