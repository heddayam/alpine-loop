import { expect, test, type Page } from "@playwright/test";

async function drawFixtureBoundary(page: Page) {
  await page.getByRole("button", { name: "Draw search boundary" }).click();
  const canvas = page.locator(".maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("MapLibre canvas has no drawable bounds");
  await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.64, box.y + box.height * 0.65, { steps: 8 });
  await page.mouse.up();
  // Keep the real draw gesture above, then normalize through the deterministic
  // demo bounds so camera timing cannot make the coordinate editor flaky.
  await page.getByRole("button", { name: "Use demo search area" }).click();
  await page.getByText("Edit boundary coordinates", { exact: true }).click();
  await page.getByLabel("West longitude").fill("-122.183");
  await page.getByLabel("South latitude").fill("37.155");
  await page.getByLabel("East longitude").fill("-122.14");
  await page.getByLabel("North latitude").fill("37.178");
  await expect(page.getByRole("status").filter({ hasText: "-122.1830" })).toBeVisible();
}

async function configureBroadDistance(page: Page, min: string, max: string) {
  await page.getByLabel("Distance minimum", { exact: true }).fill(min);
  await page.getByLabel("Distance maximum", { exact: true }).fill(max);
}

test.beforeEach(async ({ page }) => {
  const transparentTile = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://basemap.nationalmap.gov/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: transparentTile,
  }));
  await page.goto("/");
  await drawFixtureBoundary(page);
});

test("draws, configures, generates, and inspects an exact fixture route", async ({ page }) => {
  await configureBroadDistance(page, "0.1", "20");
  await page.getByLabel("Number of routes", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Generate routes" }).click();

  await expect(page.getByRole("heading", { name: "Explore results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Exact matches" })).toBeVisible();
  const exactSection = page.getByRole("region", { name: "Exact matches" });
  await expect(exactSection.getByRole("article")).toHaveCount(2);
  await expect(exactSection.getByText("Selected", { exact: true })).toBeVisible();
  await expect(page.getByText("Planning aid only. Verify current trail conditions and access before hiking.")).toBeVisible();

  const layout = await page.evaluate(() => {
    const map = document.querySelector(".map-shell")?.getBoundingClientRect();
    const builder = document.querySelector(".builder-panel")?.getBoundingClientRect();
    const results = document.querySelector(".results-panel")?.getBoundingClientRect();
    return {
      rootOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      mapWidth: map?.width,
      builderWidth: builder?.width,
      resultsWidth: results?.width,
    };
  });
  expect(layout.rootOverflow).toBe("hidden");
  expect(layout.bodyOverflow).toBe("hidden");
  await page.evaluate(() => window.scrollTo(0, 100));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(layout.mapWidth).toBeGreaterThanOrEqual(700);
  expect(layout.builderWidth).toBe(268);
  expect(layout.resultsWidth).toBe(308);

  await page.getByRole("button", { name: "Toggle plan panel" }).click();
  await expect(page.locator(".builder-panel")).toBeHidden();
  await expect.poll(async () => page.locator(".map-shell").evaluate((element) => element.getBoundingClientRect().width)).toBe(972);
  await page.getByRole("button", { name: "Toggle results panel" }).click();
  await expect(page.locator(".results-panel")).toBeHidden();
  await expect.poll(async () => page.locator(".map-shell").evaluate((element) => element.getBoundingClientRect().width)).toBe(1280);
});

test("keeps impossible constraints separate from labeled near misses", async ({ page }) => {
  await configureBroadDistance(page, "15", "16");
  await page.getByLabel("Number of routes", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Generate routes" }).click();

  await expect(page.getByText("No route met every constraint. Near misses are listed separately below.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Near misses" })).toBeVisible();
  await expect(page.getByText("Outside your constraints", { exact: true }).first()).toBeVisible();
});
