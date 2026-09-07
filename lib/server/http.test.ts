import { describe, expect, it, vi } from "vitest";
import { readJsonBody } from "./http";

function request(body: ReadableStream<Uint8Array>, headers?: HeadersInit): Request {
  return new Request("http://local/api/search", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("bounded JSON body reading", () => {
  it("decodes multibyte characters split across chunks at the byte limit", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify("é🥾"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    await expect(readJsonBody(request(body), bytes.length)).resolves.toBe("é🥾");
  });

  it("cancels a chunked body as soon as its bytes exceed the limit", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode("é"));
    });
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(readJsonBody(request(body), 3)).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE", status: 413 });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("rejects declared excess before reading and reports malformed JSON", async () => {
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    await expect(readJsonBody(request(body, { "content-length": "32769" })))
      .rejects.toMatchObject({ code: "REQUEST_TOO_LARGE", status: 413 });
    expect(pull).not.toHaveBeenCalled();
    await expect(readJsonBody(new Request("http://local", { method: "POST", body: "{" })))
      .rejects.toMatchObject({ code: "MALFORMED_JSON", status: 400 });
  });

  it("preserves read cancellation and releases the reader", async () => {
    const error = new DOMException("Cancelled", "AbortError");
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error); } });
    await expect(readJsonBody(request(body))).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });
});
