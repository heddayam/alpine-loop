// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { BoundaryEditor } from "./BoundaryEditor";
import type { Bounds } from "./types";

function KeyboardBoundary() {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  return <><BoundaryEditor key={bounds?.join(",") ?? "empty"} bounds={bounds} onChange={setBounds} /><output aria-label="Entered bounds">{bounds?.join(",")}</output></>;
}

describe("BoundaryEditor", () => {
  afterEach(cleanup);

  it("accepts a complete drawn-area rectangle without pointer input", async () => {
    render(<KeyboardBoundary />);
    await userEvent.type(screen.getByLabelText("West longitude"), "-122.18");
    await userEvent.type(screen.getByLabelText("South latitude"), "37.15");
    await userEvent.type(screen.getByLabelText("East longitude"), "-122.13");
    await userEvent.type(screen.getByLabelText("North latitude"), "37.18");
    expect(screen.getByLabelText("Entered bounds")).toHaveTextContent("-122.18,37.15,-122.13,37.18");
  });
});
