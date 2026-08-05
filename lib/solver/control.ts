export class RouteSearchCancelledError extends Error {
  constructor(readonly reason?: unknown) {
    super("Route search was cancelled");
    this.name = "RouteSearchCancelledError";
  }
}
