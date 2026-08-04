import { expect, test, type Page } from "@playwright/test";

const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function installOfflineTile(page: Page) {
  await page.route("https://basemap.nationalmap.gov/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: TRANSPARENT_TILE,
  }));
}

async function drawFixtureBoundary(page: Page) {
  await page.getByRole("button", { name: "Draw boundary" }).click();
  await expect(page.getByText("Keep the blue search box entirely inside the green installed demo coverage.")).toBeVisible();
  const canvas = page.locator(".maplibregl-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("MapLibre canvas has no drawable bounds");
  await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.64, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  // Retain the real draw gesture above, then normalize coordinates so map camera
  // or viewport changes cannot make this supplemental scenario nondeterministic.
  await page.getByRole("button", { name: "Use demo area" }).click();
  await page.getByText("Edit boundary coordinates", { exact: true }).click();
  await page.getByLabel("West longitude").fill("-122.183");
  await page.getByLabel("South latitude").fill("37.155");
  await page.getByLabel("East longitude").fill("-122.14");
  await page.getByLabel("North latitude").fill("37.178");
  await expect(page.getByRole("status").filter({ hasText: "-122.1830" })).toBeVisible();
}

async function configureDistance(page: Page, min: string, max: string) {
  await page.getByLabel("Distance minimum", { exact: true }).fill(min);
  await page.getByLabel("Distance maximum", { exact: true }).fill(max);
}

test.beforeEach(async ({ page }) => {
  await installOfflineTile(page);
});

test("preserves keyboard focus, defaults, live status, and partial-result semantics", async ({ page }) => {
  let releaseGeneration: (() => void) | undefined;
  const generationMayFinish = new Promise<void>((resolve) => { releaseGeneration = resolve; });
  await page.route("**/api/routes/generate", async (route) => {
    await generationMayFinish;
    await route.continue();
  });
  await page.goto("/");

  const routeCount = page.getByLabel("Number of routes", { exact: true });
  const uncertainSwitch = page.getByRole("switch", { name: "Include uncertain access" });
  await expect(routeCount).toHaveValue("10");
  await expect(uncertainSwitch).not.toBeChecked();
  await routeCount.focus();
  await expect(routeCount).toBeFocused();
  await routeCount.fill("20");
  await uncertainSwitch.focus();
  await page.keyboard.press("Space");
  await expect(uncertainSwitch).toBeChecked();
  await page.keyboard.press("Space");
  await expect(uncertainSwitch).not.toBeChecked();

  await drawFixtureBoundary(page);
  await configureDistance(page, "0", "20");
  await page.getByRole("button", { name: "Generate routes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Generating routes" }).first()).toBeVisible();
  releaseGeneration?.();

  await expect(page.getByRole("heading", { name: "Explore results" })).toBeVisible();
  await expect(page.getByText("Found fewer than the 20 routes requested.")).toBeVisible();
  const routeCards = page.locator(".route-card-select");
  const firstRoute = routeCards.first();
  await firstRoute.focus();
  await expect(firstRoute).toBeFocused();
  await page.keyboard.press("End");
  await expect(routeCards.last()).toBeFocused();
  await expect(routeCards.last()).toHaveAttribute("aria-pressed", "true");
});

test("labels impossible constraints as near misses and announces the no-exact state", async ({ page }) => {
  await page.goto("/");
  await drawFixtureBoundary(page);
  await configureDistance(page, "15", "16");
  await page.getByLabel("Number of routes", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Generate routes" }).click();

  await expect(page.getByText("No exact matches. 1 near match is available.")).toHaveAttribute("role", "status");
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Near misses" })).toBeVisible();
  await expect(page.getByText("Outside your constraints", { exact: true })).toBeVisible();
});

test("exposes stale source dates to assistive and visual users", async ({ page }) => {
  await page.route("**/api/routes/generate", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as {
      exact: Array<{ source: { freshness: string } }>;
      nearMisses: Array<{ source: { freshness: string } }>;
    };
    for (const result of [...body.exact, ...body.nearMisses]) {
      result.source.freshness = "2020-01-15T00:00:00Z";
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await drawFixtureBoundary(page);
  await configureDistance(page, "0", "20");
  await page.getByLabel("Number of routes", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Generate routes" }).click();

  await expect(page.getByText("Data current Jan 15, 2020")).toBeVisible();
  await expect(page.getByText("Source confidence:")).toBeVisible();
});
