const { test, expect } = require("@playwright/test");
const { configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");
const { expectPlainLanguageUi } = require("./helpers/plain-language-ui");

async function openStoredView(page, view, heading) {
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.evaluate((targetView) => {
    localStorage.setItem("safetyops.ui.view", targetView);
  }, view);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
}

test("workspace navigation and settings describe user tasks without infrastructure copy", async ({ page }) => {
  await configureAuthenticatedWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expectPlainLanguageUi(page);

  await openStoredView(page, "settings", "Workspace settings");
  await expect(page.getByRole("button", { name: "Toggle dark theme", exact: true })).toBeVisible();
  await expectPlainLanguageUi(page);
  await expect(page.getByRole("heading", { name: /Supabase connection|GitHub Pages deployment/ })).toHaveCount(0);

  // Removing explanatory cards must not remove functioning user preferences.
  const previousTheme = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: "Toggle dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", previousTheme === "dark" ? "light" : "dark");
  await expectPlainLanguageUi(page);

  await openStoredView(page, "programs", "Company forms & programs");
  await expectPlainLanguageUi(page);
});

test("company library and local upload guidance omit infrastructure providers", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { importCandidates: true, programFixture: true });
  await page.goto("/");
  await openStoredView(page, "programs", "Company forms & programs");
  await expectPlainLanguageUi(page);

  await page.locator('[data-action="program-category"][data-category="programs"]').click();
  const programCard = page.locator(".program-card").filter({ hasText: "Test safety acknowledgement program" });
  await programCard.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Test safety acknowledgement program", exact: true })).toBeVisible();
  await expect(page.getByText("Company records linked", { exact: true })).toBeVisible();
  await expectPlainLanguageUi(page);
  await page.getByRole("button", { name: "Close program details", exact: true }).click();

  await page.locator('[data-action="program-category"][data-category="forms"]').click();
  await page.getByRole("tab", { name: /Source review/ }).click();
  await expect(page.locator(".import-candidate-card")).toHaveCount(7);
  await expectPlainLanguageUi(page);

  await page.getByRole("tab", { name: /Local staging/ }).click();
  await expectPlainLanguageUi(page);
  await page.getByRole("button", { name: "Stage form locally", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectPlainLanguageUi(page);
});
