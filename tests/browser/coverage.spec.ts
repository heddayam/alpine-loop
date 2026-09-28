import { expect, test } from "@playwright/test";
import { catalog as fixtureCatalog, job as fixtureJob } from "../fixtures/coverage/catalog";
import { installOfflineHarness } from "./offline-harness";

for (const width of [1280, 390]) test(`coverage can be downloaded and paused at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const harness = await installOfflineHarness(page);
  const catalog = structuredClone(fixtureCatalog), job = structuredClone(fixtureJob);
  catalog.release!.partitioning = "local-areas";
  catalog.release!.artifacts[0].graphId = "area-fixture";
  catalog.release!.artifacts[0].startGeometry = catalog.release!.sections[0].geometry;
  catalog.release!.sections[0].area = { maximumRouteMiles: 40, bufferMiles: 25 };
  const secondArtifact = { ...catalog.release!.artifacts[0], id: "b".repeat(64), path: `objects/${"b".repeat(64)}.sqlite.gz`, graphId: "nested-area" };
  catalog.release!.artifacts.push(secondArtifact);
  catalog.release!.sections.push({ ...catalog.release!.sections[0], id: "nested", artifactIds: [secondArtifact.id] });
  const request = { releaseId: catalog.release!.id, sectionIds: ["nested", "section"] };
  job.sectionIds = request.sectionIds;
  job.totalBytes *= 2;
  await page.route("**/api/coverage**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/pause")) { job.status = "paused"; await route.fulfill({ json: job }); }
    else if (path.endsWith("/jobs")) { expect(route.request().postDataJSON()).toEqual(request); catalog.jobs = [job]; await route.fulfill({ json: job }); }
    else await route.fulfill({ json: catalog });
  });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Coverage", exact: true });
  await trigger.click();
  const dialog = page.getByRole("complementary", { name: "Manage coverage" });
  await expect(dialog).toBeVisible();
  if (width <= 600) await page.getByRole("button", { name: "Show map", exact: true }).click();
  const canvas = page.locator(".maplibregl-canvas");
  await expect(async () => {
    await canvas.hover();
    await expect(canvas).toHaveCSS("cursor", "pointer");
  }).toPass({ timeout: 10000 });
  await canvas.click();
  if (width <= 600) await page.getByRole("button", { name: "Show panel", exact: true }).click();
  await expect(dialog.getByText(/2 areas selected/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Draw trailhead filter" })).not.toBeVisible();
  await expect(dialog.getByText(/512 KiB/)).toBeVisible();
  await expect(dialog.getByText(/2.0 MiB on device/)).toBeVisible();
  await expect(dialog.getByText(/Downloads include surrounding trails for hikes up to 40 miles/)).toBeVisible();
  await dialog.getByRole("button", { name: "Show selected area" }).click();
  if (width <= 600) await page.getByRole("button", { name: "Show panel", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("coverage.png") });
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Resume" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Back to planning" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
  expect(harness.blockedExternalRequests).toEqual([]);
});
