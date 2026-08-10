import { expect, test } from "@playwright/test";

test("starts and navigates with the keyboard", async ({ page }) => {
  await page.goto("/memories");
  await expect(
    page.getByRole("heading", { name: "把散落的上下文，变成可掌控的线索" }),
  ).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByText("跳到主要内容")).toBeFocused();
  await page.getByRole("link", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "知道数据会去哪里" }),
  ).toBeVisible();
  await expect(page.getByText("已连接")).toBeVisible();
  await expect(page.getByText("记忆访问保护")).toBeVisible();
  await expect(page.getByText("模型连接")).toBeVisible();
});

test("keeps every primary action visible at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/memories");

  await expect(
    page.getByRole("link", { name: "设置", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "查看连接设置" })).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBe(widths.viewport);
});

test("honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/memories");

  const duration = await page
    .locator(".empty-orbit span")
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
});
