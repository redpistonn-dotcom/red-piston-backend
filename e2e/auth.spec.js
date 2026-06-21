const { test, expect } = require("@playwright/test");

test.describe("Auth flow", () => {
  test("page title loads", async ({ page }) => {
    await page.goto("/");
    const title = await page.title();
    expect(title).toBeTruthy();
    expect(title.length).toBeGreaterThan(0);
  });

  test("phone input exists on auth page", async ({ page }) => {
    await page.goto("/");

    // Allow for a login/auth route redirect
    const phoneInput = page
      .locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i]')
      .first();

    await expect(phoneInput).toBeVisible({ timeout: 10000 });
  });

  test("phone input accepts numeric input", async ({ page }) => {
    await page.goto("/");

    const phoneInput = page
      .locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i]')
      .first();

    await expect(phoneInput).toBeVisible({ timeout: 10000 });
    await phoneInput.fill("9876543210");
    await expect(phoneInput).toHaveValue("9876543210");
  });
});
