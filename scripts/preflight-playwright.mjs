/**
 * Установка Chromium для Playwright.
 * На Timeweb/другом хостинге: не запускайте npm install при старте — зависимости ставятся на билде.
 * Если браузер уже установлен на этапе сборки или нет прав на запись — задайте в панели:
 *   SKIP_PLAYWRIGHT_PREFLIGHT=1
 */
import { execSync } from "node:child_process";

if (process.env.SKIP_PLAYWRIGHT_PREFLIGHT === "1") {
  console.log("[preflight] SKIP_PLAYWRIGHT_PREFLIGHT=1 — пропуск playwright install");
  process.exit(0);
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") {
  console.log("[preflight] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 — пропуск");
  process.exit(0);
}

try {
  execSync("npx playwright install chromium", {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
} catch {
  process.exit(1);
}
