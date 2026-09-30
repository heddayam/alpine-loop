import { expect, test } from "@playwright/test";
import { installOfflineHarness, launchAndOpenResults, selectRegion } from "./offline-harness";

test("Full search publishes improving results and Stop preserves the open route", async ({ page }, testInfo) => {
  const harness = await installOfflineHarness(page, { improving: true });
  await page.goto("/");
  await selectRegion(page);
  await launchAndOpenResults(page);
  await expect(page.getByText("Improving results — pass 2.", { exact: true })).toBeVisible();
  await expect(page.locator(".route-card")).toHaveCount(2);

  harness.publishRouteCount(3);
  await expect(page.locator(".route-card")).toHaveCount(3, { timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath("improving-results.png") });
  await page.locator(".route-card-select").first().click();
  await expect(page.getByRole("complementary", { name: "Route details" })).toBeVisible();
  const routeTitle = await page.locator(".route-card.selected .route-summary-main strong").textContent();
  await page.getByRole("button", { name: "Stop search", exact: true }).click();
  await expect(page.getByText("Full search stopped.", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Route details" })).toBeVisible();
  await expect(page.locator(".route-card.selected .route-summary-main strong")).toHaveText(routeTitle!);
  await expect(page.getByRole("button", { name: "Stop search", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to results", exact: true }).click();
  await expect(page.locator(".route-card")).toHaveCount(3);
  expect(harness.calls.filter(call => call.method === "POST" && call.pathname.endsWith("/cancel"))).toHaveLength(1);
  expect(harness.blockedExternalRequests).toEqual([]);
});
