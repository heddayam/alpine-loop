import { defaultReachabilityService } from "@/lib/reachability/default-service";
import {
  createReachabilityCancelHandler,
  createReachabilityPollHandler,
} from "@/lib/reachability/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const service = defaultReachabilityService();
export const GET = createReachabilityPollHandler(service);
export const DELETE = createReachabilityCancelHandler(service);
