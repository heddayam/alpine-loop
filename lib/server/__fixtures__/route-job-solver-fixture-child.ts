import type { RouteJobSolverRequest, RouteJobSolverResponse } from "../route-job-solver-protocol";

function send(response: RouteJobSolverResponse): void {
  process.send?.(response);
}

process.on("message", (request: RouteJobSolverRequest) => {
  if (request.type === "close" && process.env.ALPINE_TEST_CLOSE_HANG === "1") {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (request.type === "initialize" || request.type === "close") {
    send({ id: request.id, ok: true });
    return;
  }
  if (request.type === "enumerate") {
    send({ id: request.id, ok: true, value: ["slow-access"] });
    return;
  }
  if (process.env.ALPINE_TEST_DISCONNECT === "1") {
    process.disconnect?.();
    setInterval(() => undefined, 1_000);
    return;
  }
  const duration = Number(process.env.ALPINE_TEST_SOLVE_MS ?? 0);
  const deadline = performance.now() + duration;
  while (performance.now() < deadline) {
    // Deliberately occupy this child process exactly like a synchronous solver.
  }
  send({
    id: request.id,
    ok: true,
    value: { exact: [], nearMisses: [], truncated: false },
  });
});
