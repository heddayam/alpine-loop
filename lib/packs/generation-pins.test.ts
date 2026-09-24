import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { StaleGenerationError, withGenerationLock, withGenerationPins } from "./generation-pins";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "alpine-generation-pins-"));
  roots.push(value);
  return value;
}

it("rejects a missing generation before starting a reader", async () => {
  const packRoot = await root();
  let ran = false;
  await expect(withGenerationPins(packRoot, ["missing"], async () => { ran = true; })).rejects.toBeInstanceOf(StaleGenerationError);
  expect(ran).toBe(false);
});

it("serializes asynchronous same-process generation transactions", async () => {
  const packRoot = await root();
  const order: string[] = [];
  const first = withGenerationLock(packRoot, async () => {
    order.push("first start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    order.push("first end");
  });
  const second = withGenerationLock(packRoot, () => { order.push("second"); });
  await Promise.all([first, second]);
  expect(order).toEqual(["first start", "first end", "second"]);
});
