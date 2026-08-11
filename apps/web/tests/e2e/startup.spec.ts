import { expect, test } from "@playwright/test";

test("starts and navigates with the keyboard", async ({ page }) => {
  await page.goto("/memories");
  await expect(
    page.getByRole("heading", { name: "把散落的上下文，变成可掌控的线索" }),
  ).toBeVisible();
  await expect(page.getByText("用户偏好简洁回答")).toBeVisible();
  await page.getByText("用户偏好简洁回答").click();
  await expect(page.getByRole("dialog")).toContainText("来源未记录");
  await page.getByRole("button", { name: "修改" }).click();
  await page
    .getByRole("textbox", { name: "修正后的内容" })
    .fill("用户偏好结构清晰的简洁回答");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const skipLink = page.getByText("跳到主要内容");
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
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
  await expect(page.getByRole("searchbox", { name: "搜索记忆" })).toBeVisible();
  await expect(page.getByText("用户偏好简洁回答")).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBe(widths.viewport);
});

test("shows a redacted local audit timeline", async ({ page }) => {
  await page.goto("/audit");
  await expect(
    page.getByRole("heading", { name: "每一次改变，都留下不含正文的足迹" }),
  ).toBeVisible();
  await expect(page.getByText("修改记忆")).toBeVisible();
  await expect(page.getByText(/56d8b6c529d97f12/u)).toBeVisible();
  await expect(page.getByText(/不保存记忆正文/u)).toBeVisible();
});

test("reviews a pending memory from the inbox on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/inbox");

  await expect(
    page.getByRole("heading", { name: "先确认，再让记忆参与回答" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /用户偏好简洁回答/u }).check();
  await page.getByRole("button", { name: "接受", exact: true }).click();
  await expect(page.getByText("已接受所选记忆。")).toBeVisible();
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(widths.content).toBe(widths.viewport);
});

test("keeps conflict judgment under explicit user control", async ({
  page,
}) => {
  await page.goto("/memories");
  await page.getByText("用户偏好简洁回答").click();
  await page.getByRole("button", { name: "治理冲突" }).click();
  await page.getByLabel("查找相似候选").fill("候选");
  await page.getByRole("radio").check();
  await page.getByLabel("判断依据").fill("这两条偏好互相矛盾");
  await page.getByRole("button", { name: "确认治理关系" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/memories");

  const duration = await page
    .locator(".memory-card")
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
});
