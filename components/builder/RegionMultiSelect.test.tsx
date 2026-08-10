// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegionMultiSelect, type RegionOptionGroup } from "./RegionMultiSelect";

const groups: RegionOptionGroup[] = [
  {
    packId: "santa-cruz",
    label: "Santa Cruz Mountains",
    state: "ready",
    options: [
      { id: "santa-cruz-all", name: "Whole pack" },
      { id: "castle-rock", name: "Castle Rock" },
    ],
  },
  {
    packId: "east-bay",
    label: "Southern East Bay",
    state: "ready",
    options: [{ id: "sunol", name: "Sunol and Ohlone" }],
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RegionMultiSelect", () => {
  it("groups indented checkbox options beneath non-selectable pack headings", async () => {
    render(<RegionMultiSelect groups={groups} selected={{}} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Regions: Choose regions" }));

    expect(screen.getByRole("group", { name: "Santa Cruz Mountains" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Southern East Bay" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Santa Cruz Mountains" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Castle Rock" }).closest("label"))
      .toHaveClass("region-multiselect-option");
  });

  it("changes only the selected pack and returns ids in option order", async () => {
    const onChange = vi.fn();
    const view = render(
      <RegionMultiSelect
        groups={groups}
        selected={{ "santa-cruz": ["castle-rock"], "east-bay": ["sunol"] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Regions: 2 regions selected" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Whole pack" }));
    expect(onChange).toHaveBeenLastCalledWith("santa-cruz", ["santa-cruz-all", "castle-rock"]);

    view.rerender(
      <RegionMultiSelect
        groups={groups}
        selected={{ "santa-cruz": ["santa-cruz-all", "castle-rock"], "east-bay": ["sunol"] }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Castle Rock" }));
    expect(onChange).toHaveBeenLastCalledWith("santa-cruz", ["santa-cruz-all"]);
  });

  it("summarizes zero, one, and multiple controlled selections", () => {
    const view = render(<RegionMultiSelect groups={groups} selected={{}} onChange={vi.fn()} />);
    expect(screen.getByText("Choose regions")).toBeVisible();

    view.rerender(
      <RegionMultiSelect groups={groups} selected={{ "santa-cruz": ["castle-rock"] }} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Castle Rock")).toBeVisible();

    view.rerender(
      <RegionMultiSelect
        groups={groups}
        selected={{ "santa-cruz": ["castle-rock"], "east-bay": ["sunol"] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("2 regions selected")).toBeVisible();
  });

  it("closes with Escape, restores trigger focus, and dismisses outside", async () => {
    render(<RegionMultiSelect groups={groups} selected={{}} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Regions: Choose regions" });
    await userEvent.click(trigger);
    screen.getByRole("checkbox", { name: "Whole pack" }).focus();
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("group", { name: "Region selection" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Region selection" })).not.toBeInTheDocument();
  });

  it("shows loading and error feedback within the corresponding groups", async () => {
    const pendingGroups: RegionOptionGroup[] = [
      { packId: "monterey", label: "Monterey and Carmel", state: "loading", options: [] },
      { packId: "henry-coe", label: "Henry Coe", state: "error", error: "Could not load regions.", options: [] },
    ];
    render(<RegionMultiSelect groups={pendingGroups} selected={{}} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Regions: Choose regions" }));

    expect(screen.getByRole("group", { name: "Monterey and Carmel" }))
      .toHaveTextContent("Loading regions…");
    expect(screen.getByRole("group", { name: "Henry Coe" }))
      .toHaveTextContent("Could not load regions.");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load regions.");
  });
});
