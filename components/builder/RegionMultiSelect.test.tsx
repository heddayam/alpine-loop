// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegionMultiSelect } from "./RegionMultiSelect";

const options = [
  { id: "santa-cruz-all", name: "Santa Cruz Mountains" },
  { id: "castle-rock", name: "Castle Rock" },
  { id: "sunol", name: "Sunol and Ohlone" },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RegionMultiSelect", () => {
  it("returns selected regions in catalog order", async () => {
    const onChange = vi.fn();
    const view = render(
      <RegionMultiSelect
        options={options}
        selected={["castle-rock", "sunol"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Regions: 2 regions selected" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Santa Cruz Mountains" }));
    expect(onChange).toHaveBeenLastCalledWith(["santa-cruz-all", "castle-rock", "sunol"]);

    view.rerender(
      <RegionMultiSelect
        options={options}
        selected={["santa-cruz-all", "castle-rock", "sunol"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Castle Rock" }));
    expect(onChange).toHaveBeenLastCalledWith(["santa-cruz-all", "sunol"]);
  });

  it("summarizes zero, one, and multiple controlled selections", () => {
    const view = render(<RegionMultiSelect options={options} selected={[]} onChange={vi.fn()} />);
    expect(screen.getByText("Choose regions")).toBeVisible();

    view.rerender(
      <RegionMultiSelect options={options} selected={["castle-rock"]} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Castle Rock")).toBeVisible();

    view.rerender(
      <RegionMultiSelect
        options={options}
        selected={["castle-rock", "sunol"]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("2 regions selected")).toBeVisible();
  });

  it("closes with Escape, restores trigger focus, and dismisses outside", async () => {
    render(<RegionMultiSelect options={options} selected={[]} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Regions: Choose regions" });
    await userEvent.click(trigger);
    screen.getByRole("checkbox", { name: "Santa Cruz Mountains" }).focus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("group", { name: "Region selection" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Region selection" })).not.toBeInTheDocument();
  });

});
