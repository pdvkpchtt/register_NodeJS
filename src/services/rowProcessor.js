import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { MailSlurp } from "mailslurp-client";
import "dotenv/config";
import * as cheerio from "cheerio";

// Функция для извлечения кода из HTML
function extractVerificationCode(htmlContent) {
  // Загружаем HTML в cheerio
  const $ = cheerio.load(htmlContent);

  const text = $("body").text();

  // Регулярное выражение для поиска кода (4 цифры после фразы)
  const regex =
    /Для подтверждения регистрации учетной записи введи код подтверждения\.\s*(\d{4})/;
  const match = text.match(regex);

  if (match) {
    const fullPhrase = match[0]; // Полная фраза с кодом
    const code = match[1]; // Только код (1066)

    return {
      fullPhrase,
      code,
      success: true,
    };
  }

  return {
    success: false,
    message: "Код подтверждения не найден",
  };
}

chromium.use(stealth());

const BROWSER_CONFIG = {
  headless: true,  // 🔥 Меняем false → true (или "new" для нового режима)
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    // 🔥 Дополнительные флаги для стабильного headless-режима:
    "--disable-gpu",           // Отключаем GPU (не нужен в headless)
    "--disable-software-rasterizer",
    "--disable-setuid-sandbox",
  ],
};

const INIT_SCRIPTS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  window.chrome = { runtime: {} };
`;

export const processRow = async (row, options = {}, emitLog = null) => {
  const {
    loginUrl = "https://identity.rsv.ru/Registration?returnUrl=%2Fconnect%2Fauthorize%2Fcallback%3Fclient_id%3Drsv-moyastrana%26redirect_uri%3Dhttps%253A%252F%252Fcabinet.moyastrana.ru%252Frsv-auth%252F%26response_type%3Dcode%26scope%3Dopenid%2520profile%26code_challenge%3DIrWiNqN2a6LErDuSSjio_IXruOylczA9YIQ6VkA4-fI%26code_challenge_method%3DS256",
    familia = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[1]/input",
    imya = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[2]/input",
    otchestvo = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[3]/input",
    city = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[5]/input[1]",
    birthDay = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[6]/div[2]/div[1]/select",
    birthMonth = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[6]/div[2]/div[2]/select",
    birthYear = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[6]/div[2]/div[3]/select",
    emailField = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[7]/div[3]/input",
    passwordField = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[8]/input",
    passwordRepeatField = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[9]/input",
    checkBoxOne = '//*[@id="IsUserAgreementAccepted"]',
    submitButton = "/html/body/div[4]/div[1]/div/div/div[3]/form/div[12]/button",

    secondInput = "/html/body/div[4]/div[1]/div/div/div/form/div[1]/input",
    secondSubmitButton = "/html/body/div[4]/div[1]/div/div/div/form/div[3]/button",

    humanDelayMin = 1000,
    humanDelayMax = 3000,
    externalEmail = null, // 🔥 Опционально: использовать существующую почту
  } = options;

  // Инициализация MailSlurp
  const mailslurp = new MailSlurp({
    apiKey: process.env.EMAIL_API,
    timeout: 30000,
  });

  // 🔥 Создаём почту ТОЛЬКО если не передана externalEmail
  const inbox = await mailslurp.inboxController.createInboxWithDefaults();
  const emailAddress = inbox.emailAddress;
  const emailId = inbox.id;

  const userName = row["Фамилия"] || row["ФАМИЛИЯ"] || "User";
  let browser;

  const log = (level, message, meta = {}) => {
    console.log(`[${level}] ${message}`, meta);
    if (emitLog) {
      emitLog(level, message, {
        user: userName,
        email: emailAddress,
        ...meta,
        timestamp: new Date().toISOString(),
      });
    }
  };

  try {
    log("info", `🚀 Запуск браузера...`);
    if (!externalEmail)
      log("info", `📧 Создана временная почта: ${emailAddress}`);

    browser = await chromium.launch(BROWSER_CONFIG);
    const context = await browser.newContext({
      viewport: BROWSER_CONFIG.viewport,
      userAgent: BROWSER_CONFIG.userAgent,
    });
    const page = await context.newPage();
    await page.addInitScript(INIT_SCRIPTS);

    log("info", `🔗 Переход на ${loginUrl}`);
    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // === Заполнение формы ===
    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Фамилия"]) {
      log("info", `⌨️ Ввод фамилии...`);
      await typeHumanLike(page, familia, row["Фамилия"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Имя"]) {
      log("info", `⌨️ Ввод имени...`);
      await typeHumanLike(page, imya, row["Имя"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Отчество"]) {
      log("info", `⌨️ Ввод отчества...`);
      await typeHumanLike(page, otchestvo, row["Отчество"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Город"]) {
      log("info", `⌨️ Ввод города...`);
      await typeHumanLike(page, city, row["Город"]);
      await randomDelay(500, 1000);
      await page.keyboard.press("ArrowDown", { delay: 100 });
      await randomDelay(100, 300);
      await page.keyboard.press("Enter", { delay: 100 });
      log("info", `✅ Город выбран: ${row["Город"]}`);
    }

    // === Дата рождения ===
    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Дата рождения"]) {
      log("info", `⌨️ Ввод даты рождения...`);
      const birthDate = row["Дата рождения"].split(" ");
      const day = birthDate[0];
      const month = birthDate[1];
      const year = birthDate[2];

      // День
      await page.locator(`xpath=${birthDay}`).click({ delay: 200 });
      await randomDelay(200, 500);
      const dayNum = parseInt(day, 10);
      if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
        for (let i = 0; i < dayNum; i++) {
          await page.keyboard.press("ArrowDown", {
            delay: 50 + Math.random() * 50,
          });
        }
        await randomDelay(100, 300);
        await page.keyboard.press("Enter", { delay: 100 });
        log("info", `✅ День выбран: ${dayNum}`);
      }

      // Месяц
      if (month) {
        await randomDelay(200, 400);
        await page.locator(`xpath=${birthMonth}`).click({ delay: 200 });
        await randomDelay(200, 500);
        const monthNum = parseInt(month, 10);
        if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
          for (let i = 0; i < monthNum; i++) {
            await page.keyboard.press("ArrowDown", {
              delay: 50 + Math.random() * 50,
            });
          }
          await randomDelay(100, 300);
          await page.keyboard.press("Enter", { delay: 100 });
          log("info", `✅ Месяц выбран: ${monthNum}`);
        }
      }

      // Год
      if (year) {
        await randomDelay(200, 400);
        await page.locator(`xpath=${birthYear}`).click({ delay: 200 });
        await randomDelay(200, 500);
        const yearNum = parseInt(year, 10);
        if (!isNaN(yearNum)) {
          const yearIndex = 2024 - yearNum;
          for (let i = 0; i < yearIndex; i++) {
            await page.keyboard.press("ArrowDown", {
              delay: 30 + Math.random() * 30,
            });
          }
          await randomDelay(100, 300);
          await page.keyboard.press("Enter", { delay: 100 });
          log("info", `✅ Год выбран: ${yearNum}`);
        }
      }
    }

    // === Почта ===
    await randomDelay(humanDelayMin, humanDelayMax);
    if (emailAddress) {
      log("info", `⌨️ Ввод почты: ${emailAddress}`);
      await typeHumanLike(page, emailField, emailAddress);
    }

    // === Пароль ===
    await randomDelay(humanDelayMin, humanDelayMax);
    if (row["Пароль"]) {
      log("info", `⌨️ Ввод пароля...`);
      await typeHumanLike(page, passwordField, row["Пароль"]);
      await typeHumanLike(page, passwordRepeatField, row["Пароль"]);
    }

    // === Чекбокс ===
    await randomDelay(humanDelayMin, humanDelayMax);
    log("info", `🖱️ Клик по чекбоксу...`);
    await page.locator(`xpath=${checkBoxOne}`).click({ delay: 200 });

    // === Капча ===
    await randomDelay(humanDelayMin, humanDelayMax);
    log("info", `🔍 Проверка капчи...`);
    if (
      await page.isVisible("#yandexSmartCaptchaContainer", { timeout: 3000 })
    ) {
      log("info", `🧩 Yandex SmartCaptcha обнаружена`);
      await page
        .locator("#yandexSmartCaptchaContainer")
        .click({ position: { x: 15, y: 15 }, delay: 100 });

      const tokenAppeared = await page
        .waitForFunction(
          () =>
            document.querySelector('input[name="smart-token"]')?.value?.length >
            20,
          { timeout: 15000 }
        )
        .catch(() => null);

      if (tokenAppeared) {
        log("info", `✅ Капча пройдена`);
      } else {
        log("warn", `⚠️ Капча не пройдена автоматически`);
        await randomDelay(5000, 10000);
      }
    }

    // === Отправка ===
    await randomDelay(humanDelayMin, humanDelayMax);
    log("info", `🖱️ Клик по "Продолжить"...`);
    await page.locator(`xpath=${submitButton}`).click({ delay: 200 });

    // 🔥 === ОЖИДАНИЕ ПЕРЕХОДА НА СТРАНИЦУ ПОДТВЕРЖДЕНИЯ ===
    log("info", `⏳ Ожидание перехода на страницу подтверждения...`);

    try {
      const encodedEmail = encodeURIComponent(emailAddress);

      // 🔥 ИСПРАВЛЕНИЕ: url.href вместо url
      await page.waitForURL(
        (url) =>
          url.href.includes("/Registration/Confirmation") &&
          url.href.includes(`PhoneOrEmail=${encodedEmail}`),
        {
          timeout: 30000,
          waitUntil: "load",
        }
      );

      log("success", `✅ Страница подтверждения загружена`);
    } catch (err) {
      log("warn", `⚠️ Не удалось дождаться по email, пробуем общий паттерн...`);

      try {
        // 🔥 То же исправление здесь
        await page.waitForURL(
          (url) => url.href.includes("/Registration/Confirmation"),
          {
            timeout: 15000,
            waitUntil: "domcontentloaded",
          }
        );
        log("success", `✅ Страница подтверждения загружена (общий паттерн)`);
      } catch (err2) {
        log(
          "error",
          `❌ Не удалось дождаться страницы подтверждения: ${err2.message}`
        );
      }
    }

    // 🔥 Обновляем currentUrl ПОСЛЕ ожидания
    const currentUrl = page.url();
    log("debug", `🔗 Текущий URL: ${currentUrl}`);

    // === Получение кода из почты ===
    const emailPagination = await mailslurp.emailController.getEmailsPaginated({
      inboxId: emailId,
      sort: "DESC",
      page: 0,
      size: 10,
    });

    let code = null;
    const emails = emailPagination.content || [];

    if (emails.length > 0) {
      try {
        const fullEmail = await mailslurp.emailController.getEmail({
          emailId: emails[0].id,
        });
        const result = extractVerificationCode(fullEmail.body);
        code = result.code;
        if (code) log("info", `✅ Код из письма: ${code}`);
      } catch (e) {
        log("error", `❌ Не удалось получить код: ${e.message}`);
      }
    } else {
      log("warn", `⚠️ Письма не найдены в инбоксе`);
    }

    // === Ввод кода подтверждения ===
    if (code) {
      await randomDelay(humanDelayMin, humanDelayMax);
      log("info", `⌨️ Ввод кода: ${code}`);

      // Ждём появления поля ввода кода
      await page
        .waitForSelector(`xpath=${secondInput}`, {
          state: "visible",
          timeout: 10000,
        })
        .catch(() => log("warn", `⚠️ Поле для кода не найдено`));

      await typeHumanLike(page, secondInput, code);

      await randomDelay(humanDelayMin, humanDelayMax);
      log("info", `🖱️ Клик по "Подтвердить"...`);
      await page.locator(`xpath=${secondSubmitButton}`).click({ delay: 200 });

      // Ждём финального редиректа
      await page
        .waitForURL(
          (url) =>
            url.href.includes("cabinet.moyastrana.ru") ||
            url.href.includes("/Account/Login"),
          { timeout: 30000 }
        )
        .catch(() => {
          log("warn", `⚠️ Таймаут ожидания финального редиректа`);
        });

      await randomDelay(5000, 7000);
    }

    // === Финальная проверка успеха ===
    const finalUrl = page.url();
    const success =
      finalUrl.includes("cabinet.moyastrana.ru") ||
      (finalUrl.includes("/Registration/Confirmation") && code !== null);

    log(
      success ? "success" : "warn",
      `🎯 Результат: ${
        success ? "✅ Успех" : "⚠️ Неизвестно"
      } | URL: ${finalUrl}`
    );

    return {
      success,
      row,
      email: emailAddress,
      emailId: emailId,
      confirmationCode: code,
      timestamp: new Date().toISOString(),
      url: finalUrl,
    };
  } catch (err) {
    log("error", `❌ Ошибка: ${err.message}`, { stack: err.stack });
    return {
      success: false,
      row,
      email: emailAddress, // 🔥 Возвращаем почту даже при ошибке
      emailId: emailId,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (browser) {
      await browser.close();
      log("info", `🔚 Браузер закрыт`);
    }
  }
};

const randomDelay = (min, max) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.random() * (max - min) + min)
  );

const typeHumanLike = async (page, xpath, text) => {
  const locator = page.locator(`xpath=${xpath}`);
  await locator.focus();
  for (const char of text) {
    await locator.pressSequentially(char, { delay: Math.random() * 50 + 25 });
  }
};

export default { processRow };
