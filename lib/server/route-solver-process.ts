import type { RouteSearchResult } from "@/lib/solver/types";
import { AccessFilterResolutionError, type RouteSearchPolicy, type SolverBudget } from "@/lib/solver";
import { ServerApiError } from "./api-error";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type {
  StartSearchResult,
  RouteSolverRequest,
  RouteSolverResponse,
  RouteSolverWorkerInput,
} from "./route-solver-protocol";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  removeAbortListener(): void;
};

type RouteSolverProcessOptions = {
  modulePath?: string;
  env?: Record<string, string | undefined>;
  closeTimeoutMs?: number;
};

type RouteSolverRequestWithoutId = RouteSolverRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

function cancellationError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Cancelled", "AbortError");
}

function remoteError(value: Extract<RouteSolverResponse, { ok: false }>["error"]): Error {
  const error = value.code && ["START_NOT_FOUND", "START_OUTSIDE_FILTER", "START_INELIGIBLE"].includes(value.code)
    ? new AccessFilterResolutionError(value.code as AccessFilterResolutionError["code"], value.message)
    : value.code && value.status ? new ServerApiError(value.code, value.message, value.status)
      : new Error(value.message);
  error.name = value.name;
  if (value.stack) error.stack = value.stack;
  return error;
}

export class RouteSolverProcess {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #closeTimeoutMs: number;
  #nextRequestId = 1;
  #ended = false;

  private constructor(options: RouteSolverProcessOptions) {
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    const modulePath = options.modulePath ?? resolve(process.cwd(), "lib/server/route-solver-child.ts");
    // A direct fork(modulePath) call is treated as a bundle-time module
    // reference by Turbopack. This child is intentionally a local Node runtime
    // entrypoint resolved from the source checkout instead.
    const forkAtRuntime: typeof import("node:child_process").fork = process.getBuiltinModule("node:child_process").fork;
    this.#child = forkAtRuntime(modulePath, [], {
      env: { ...process.env, ...options.env },
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.#child.on("message", (message: RouteSolverResponse) => this.#handleResponse(message));
    this.#child.on("error", (error) => this.#terminate(error));
    this.#child.on("disconnect", () => {
      if (!this.#ended) this.#terminate(new Error("Route solver process disconnected unexpectedly."));
    });
    this.#child.on("exit", (code, signal) => {
      if (!this.#ended) this.#finish(new Error(`Route solver process exited unexpectedly (${signal ?? code ?? "unknown"}).`));
    });
  }

  static async open(
    input: RouteSolverWorkerInput,
    signal: AbortSignal,
    options: RouteSolverProcessOptions = {},
  ): Promise<RouteSolverProcess> {
    const process = new RouteSolverProcess(options);
    try {
      await process.#request({ type: "initialize", input }, signal);
      return process;
    } catch (error) {
      process.#terminate();
      throw error;
    }
  }

  async enumerateEligibleAccessPointIds(signal: AbortSignal): Promise<readonly string[]> {
    return this.#request({ type: "enumerate" }, signal) as Promise<readonly string[]>;
  }

  async searchAccessPoint(accessPointId: string, signal: AbortSignal): Promise<StartSearchResult> {
    return this.#request({ type: "search", accessPointId }, signal) as Promise<StartSearchResult>;
  }

  async generate(policy: RouteSearchPolicy, budget: SolverBudget, signal: AbortSignal): Promise<RouteSearchResult> {
    return this.#request({ type: "generate", policy, budget }, signal) as Promise<RouteSearchResult>;
  }

  async close(): Promise<void> {
    if (this.#ended) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Route solver process did not close within ${this.#closeTimeoutMs} ms.`));
    }, this.#closeTimeoutMs);
    try {
      await this.#request({ type: "close" }, controller.signal);
    } finally {
      clearTimeout(timer);
      this.#terminate();
    }
  }

  #request(
    request: RouteSolverRequestWithoutId,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      this.#terminate();
      return Promise.reject(cancellationError(signal));
    }
    if (this.#ended || !this.#child.connected) return Promise.reject(new Error("Route solver process is unavailable."));
    const id = this.#nextRequestId++;
    return new Promise((resolveRequest, reject) => {
      const abort = () => {
        this.#terminate(cancellationError(signal));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject,
        removeAbortListener: () => signal.removeEventListener("abort", abort),
      });
      this.#child.send({ ...request, id } as RouteSolverRequest, (error) => {
        if (error) this.#terminate(error);
      });
    });
  }

  #handleResponse(message: RouteSolverResponse): void {
    if (!message || typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    pending.removeAbortListener();
    if (message.ok) pending.resolve(message.value);
    else pending.reject(remoteError(message.error));
  }

  #terminate(reason: unknown = new Error("Route solver process was closed.")): void {
    if (!this.#ended) this.#child.kill();
    this.#finish(reason);
  }

  #finish(reason: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const pending of this.#pending.values()) {
      pending.removeAbortListener();
      pending.reject(reason);
    }
    this.#pending.clear();
  }
}
