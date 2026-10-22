import { expect, test, type Page } from "@playwright/test";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const plant = (id: string, over: Record<string, unknown> = {}) => ({
  plant_id: id, zone: "A", block: "01", block_id: "A-01", slot_id: null,
  latitude: 7.3, longitude: 80.6, location_error_m: 3, location_source: "gps",
  last_inspection_date: daysAgo(2), foliage_color: "Green", soil_ph: 6.2, moisture: 40, vine_height_cm: 120,
  health_class: null, trend: null, ...over,
});

const twinState = [
  plant("P-HEALTHY"),
  plant("P-HOT1"),
  plant("P-HOT2"),
  plant("P-STALE-RISK", { foliage_color: "Brown", last_inspection_date: daysAgo(90) }),
  plant("P-NEVER", { last_inspection_date: null, foliage_color: null, soil_ph: null }),
  plant("P-ESTIMATED", { location_source: "estimated" }),
  plant("P-DEAD", { foliage_color: "Red", last_inspection_date: daysAgo(90) }),
];

const hotspotRow = (id: string, cluster: number, cause: string, referred: boolean, status: string) => ({
  plant_id: id, cycle: "2026-10-01", cluster_id: cluster, created_at: "2026-10-21T00:00:00Z",
  params: { hotspot_id: `H00${cluster}`, likely_cause: cause, referred_to_module1: referred, status, n_members: 2, area_m2: 300 },
});

const trends = [
  { level: "block", entity_id: "C-02", window_start: "2026-08-01", window_end: "2026-10-21", n_cycles: 8, trend: "declining", slope: 0.2, unhealthy_share: 1, model_version: "t", created_at: "2026-10-21" },
  { level: "zone", entity_id: "A", window_start: "2026-08-01", window_end: "2026-10-21", n_cycles: 25, trend: "improving", slope: -0.1, unhealthy_share: 0, model_version: "t", created_at: "2026-10-21" },
];

async function harness(page: Page, opts: { hotspots?: unknown[]; diseaseUp?: boolean } = {}) {
  const hotspots = opts.hotspots ?? [
    hotspotRow("P-HOT1", 1, "likely_disease", true, "expanding"),
    hotspotRow("P-HOT2", 1, "likely_disease", true, "expanding"),
  ];
  await page.route("**/rest/v1/plant_health_hotspots*", (r) => r.fulfill({ json: hotspots }));
  await page.route("**/rest/v1/twin_state*", (r) => r.fulfill({ json: twinState }));
  await page.route("**/rest/v1/health_trends*", (r) => r.fulfill({ json: trends }));
  await page.route("**/api/disease/status", (r) =>
    opts.diseaseUp === false
      ? r.abort("connectionrefused")
      : r.fulfill({ json: { model_loaded: true, model_version: "e1-test", classes: [], status: "baseline, not validated", detail: null } }),
  );
  await page.route("http://127.0.0.1:8001/health", (r) => r.abort("connectionrefused"));
  await page.goto("/overview");
}

test("ranks the field plan by reason and skips dead plants", async ({ page }) => {
  await harness(page);
  const rows = page.getByTestId("field-plan").locator(":scope > li");
  await expect(rows.first()).toContainText("P-HOT");
  await expect(rows.nth(2)).toContainText("P-STALE-RISK");
  await expect(rows.nth(3)).toContainText("P-NEVER");
  await expect(rows.nth(4)).toContainText("P-ESTIMATED");
  await expect(page.getByTestId("field-plan")).not.toContainText("P-DEAD");
  await expect(page.getByTestId("field-plan")).not.toContainText("P-HEALTHY");
  await expect(rows.first().getByRole("link", { name: "Inspect" })).toHaveAttribute("href", /\/new-inspection\?plant_id=P-HOT/);
});

test("hotspot check opens the disease page with plant context", async ({ page }) => {
  await harness(page);
  const checks = page.getByTestId("hotspot-checks");
  await expect(checks).toContainText("H001");
  await expect(checks).toContainText("Referred");
  await checks.getByRole("link", { name: "P-HOT1" }).click();
  await expect(page).toHaveURL(/\/disease-detection\?plant=P-HOT1&hotspot=H001/);
  await expect(page.getByTestId("check-context")).toContainText("P-HOT1");
  await expect(page.getByTestId("check-context")).toContainText("H001");
});

test("shows declining areas first and folds the rest", async ({ page }) => {
  await harness(page);
  const areas = page.getByTestId("area-trends");
  await expect(areas).toContainText("Block C-02");
  await expect(areas).not.toContainText("Zone A");
  await page.getByRole("button", { name: /Show the other 1/ }).click();
  await expect(areas).toContainText("Zone A");
});

test("offline modules and no hotspots do not break the page", async ({ page }) => {
  await harness(page, { hotspots: [], diseaseUp: false });
  const status = page.getByTestId("module-status");
  await expect(status).toContainText("Disease API not reachable");
  await expect(status).toContainText("Advisory service not running");
  await expect(status).toContainText("7 plants · 0 hotspots");
  await expect(page.getByText("No hotspots need a disease check this cycle.")).toBeVisible();
  await expect(page.getByTestId("data-trust")).toContainText("86%"); // 6 of 7 inspected
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(page.viewportSize()!.width);
});
