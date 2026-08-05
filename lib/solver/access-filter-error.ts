export class AccessFilterResolutionError extends Error {
  constructor(
    readonly code: "START_NOT_FOUND" | "START_OUTSIDE_FILTER" | "START_INELIGIBLE",
    message: string,
  ) {
    super(message);
    this.name = "AccessFilterResolutionError";
  }
}
