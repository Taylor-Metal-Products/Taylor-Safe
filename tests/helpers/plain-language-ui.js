const { expect } = require("@playwright/test");

// Use only with synthetic fixtures whose content is controlled by these tests.
// Tenant-authored titles and files may legitimately mention either provider.
async function expectPlainLanguageUi(page) {
  expect(await page.locator("body").innerText()).not.toMatch(/github|supabase/i);
  expect(await page.title()).not.toMatch(/github|supabase/i);
  const visibleLabels = await page.locator("[title]:visible, [aria-label]:visible").evaluateAll((elements) =>
    elements.flatMap((element) => [element.getAttribute("title"), element.getAttribute("aria-label")]).filter(Boolean)
  );
  expect(visibleLabels.join("\n")).not.toMatch(/github|supabase/i);
}

module.exports = { expectPlainLanguageUi };
