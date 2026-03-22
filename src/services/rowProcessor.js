import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import "dotenv/config";
import * as cheerio from "cheerio";

// 🔥 Функция для извлечения кода из HTML
function extractVerificationCode(htmlContent) {
  if (!htmlContent || htmlContent.trim().length < 10) {
    console.log(
      `⚠️ Пустой или слишком короткий контент: "${htmlContent?.substring(
        0,
        100
      )}"`
    );
    return {
      success: false,
      message: "Пустой контент",
      preview: htmlContent?.substring(0, 200),
    };
  }

  const $ = cheerio.load(htmlContent);
  const text = $("body").text().replace(/\s+/g, " ").trim();

  console.log(`🔍 Парсим текст письма: "${text.substring(0, 300)}..."`);

  const patterns = [
    /(?:код|code|confirmation|подтверждения)[^:\d]*[:\s]*([A-Z0-9]{4,6})/i,
    /([0-9]{6})/,
    /([A-Z0-9]{4,6})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const code = match[1].trim().toUpperCase();
      if (
        code.length >= 4 &&
        code.length <= 6 &&
        !code.includes("HTTP") &&
        !code.includes("WWW")
      ) {
        console.log(`✅ Код найден: ${code}`);
        return { code, success: true };
      }
    }
  }

  console.log(`⚠️ Код не найден в тексте. Доступные паттерны не сработали.`);
  return {
    success: false,
    message: "Код подтверждения не найден",
    preview: text.substring(0, 200),
  };
}

// 🔥 Создание временной почты через post-shift.ru
async function createPostShiftEmail(name = null, domain = "post-shift.ru") {
  const hash = process.env.POST_SHIFT_HASH;
  if (!hash) throw new Error("POST_SHIFT_HASH не настроен в .env");

  const emailName =
    name ||
    `user${Math.random().toString(36).substring(2, 8)}`.substring(0, 10);

  const response = await axios.get("https://post-shift.ru/api.php", {
    params: {
      action: "new",
      hash,
      name: emailName,
      domain,
    },
    timeout: 10000,
  });

  const { email, key } = response.data;
  if (!email || !key) {
    throw new Error(
      `Не удалось создать почту: ${JSON.stringify(response.data)}`
    );
  }
  return { email, key };
}

// 🔥 Получение списка писем
async function getPostShiftMessages(key) {
  const hash = process.env.POST_SHIFT_HASH;

  try {
    const response = await axios.get("https://post-shift.ru/api.php", {
      params: {
        action: "getlist",
        hash,
        key,
      },
      timeout: 10000,
    });

    // 🔥 Лог для отладки
    console.log(`📡 getlist ответ:`, {
      status: response.status,
      data: response.data,
      isArray: Array.isArray(response.data),
    });

    // API может вернуть объект с ошибкой
    if (response.data?.error) {
      console.warn(`⚠️ API ошибка getlist: ${response.data.error}`);
      return [];
    }

    return Array.isArray(response.data) ? response.data : [];
  } catch (err) {
    console.error(`❌ getlist failed:`, err.response?.data || err.message);
    return [];
  }
}

// 🔥 Получение текста письма
async function getPostShiftMessage(key, messageId) {
  const hash = process.env.POST_SHIFT_HASH;

  try {
    // 🔥 Сначала пробуем с forced=1 (без cut и base64)
    const response = await axios.get("https://post-shift.ru/api.php", {
      params: {
        action: "getmail",
        hash,
        key,
        id: messageId,
        forced: 1, // 🔥 КЛЮЧЕВОЙ ПАРАМЕТР: возвращает письмо без обработки
      },
      timeout: 10000,
    });

    console.log(`📡 getmail #${messageId} ответ:`, {
      status: response.status,
      hasMessage: !!response.data?.message,
      fullResponse: response.data, // 🔥 Логим весь ответ для отладки
    });

    // 🔥 Проверяем разные возможные поля в ответе
    const message =
      response.data?.message ||
      response.data?.text ||
      response.data?.body ||
      response.data?.content ||
      "";

    return message;
  } catch (err) {
    console.error(`❌ getmail failed:`, err.response?.data || err.message);
    return "";
  }
}

// 🔥 Очистка/удаление ящика
async function cleanupPostShiftInbox() {
  try {
    await axios.get("https://post-shift.ru/api.php?action=deleteall");

    console.log(`🗑️ Ящики удалены`);
    return true;
  } catch (err) {
    console.warn(`⚠️ Не удалось удалить ящики`);
    return false;
  }
}

chromium.use(stealth());

const BROWSER_CONFIG = {
  headless: false,
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
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
    externalEmail = null,
    externalEmailKey = null,
  } = options;

  let emailAddress, emailKey;
  if (externalEmail && externalEmailKey) {
    emailAddress = externalEmail;
    emailKey = externalEmailKey;
  } else {
    const postShift = await createPostShiftEmail();
    emailAddress = postShift.email;
    emailKey = postShift.key;
  }

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
    cleanupPostShiftInbox();
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
      const day = birthDate[0],
        month = birthDate[1],
        year = birthDate[2];

      // День
      await page.locator(`xpath=${birthDay}`).click({ delay: 200 });
      await randomDelay(200, 500);
      const dayNum = parseInt(day, 10);
      if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
        for (let i = 0; i < dayNum; i++)
          await page.keyboard.press("ArrowDown", {
            delay: 50 + Math.random() * 50,
          });
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
          for (let i = 0; i < monthNum; i++)
            await page.keyboard.press("ArrowDown", {
              delay: 50 + Math.random() * 50,
            });
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
          for (let i = 0; i < yearIndex; i++)
            await page.keyboard.press("ArrowDown", {
              delay: 30 + Math.random() * 30,
            });
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
      if (tokenAppeared) log("info", `✅ Капча пройдена`);
      else {
        log("warn", `⚠️ Капча не пройдена автоматически`);
        await randomDelay(5000, 10000);
      }
    }

    // === Отправка ===
    await randomDelay(humanDelayMin, humanDelayMax);
    log("info", `🖱️ Клик по "Продолжить"...`);
    await page.locator(`xpath=${submitButton}`).click({ delay: 200 });

    // === Ожидание страницы подтверждения ===
    log("info", `⏳ Ожидание перехода на страницу подтверждения...`);
    try {
      const encodedEmail = encodeURIComponent(emailAddress);
      await page.waitForURL(
        (url) =>
          url.href.includes("/Registration/Confirmation") &&
          url.href.includes(`PhoneOrEmail=${encodedEmail}`),
        { timeout: 30000, waitUntil: "load" }
      );
      log("success", `✅ Страница подтверждения загружена`);
    } catch (err) {
      log("warn", `⚠️ Не удалось дождаться по email, пробуем общий паттерн...`);
      try {
        await page.waitForURL(
          (url) => url.href.includes("/Registration/Confirmation"),
          { timeout: 15000, waitUntil: "domcontentloaded" }
        );
        log("success", `✅ Страница подтверждения загружена (общий паттерн)`);
      } catch (err2) {
        log("error", `❌ Не удалось дождаться: ${err2.message}`);
      }
    }

    const currentUrl = page.url();
    log("debug", `🔗 Текущий URL: ${currentUrl}`);

    // === Получение кода из почты ===
    log("info", `📬 Проверка почты ${emailAddress}...`);

    let code = null;
    const maxAttempts = 30; // 🔥 90 секунд ожидания
    const pollInterval = 3000; // 3 секунды между попытками

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const messages = await getPostShiftMessages(emailKey);

        log(
          "debug",
          `🔍 Попытка ${attempt}/${maxAttempts}: найдено писем: ${messages.length}`
        );

        if (messages.length > 0) {
          log(
            "info",
            `✅ Письма получены: ${messages.map((m) => m.subject).join(", ")}`
          );

          const firstMessage = messages[0];
          const fullText = await getPostShiftMessage(emailKey, firstMessage.id);

          // 🔥 Лог полного текста для отладки
          console.log(
            `📄 Текст письма #${firstMessage.id}:`,
            fullText.substring(0, 500)
          );

          const result = extractVerificationCode(fullText);
          if (result.success) {
            code = result.code;
            log("info", `✅ Код найден: ${code}`);
            break;
          } else {
            log(
              "warn",
              `⚠️ Код не распознан. Текст: "${fullText.substring(0, 200)}..."`,
              result
            );
          }
        }
      } catch (e) {
        log("error", `❌ Ошибка при чтении почты: ${e.message}`);
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    }

    if (!code) {
      log(
        "warn",
        `⚠️ Код не получен после ${maxAttempts} попыток (${
          (maxAttempts * pollInterval) / 1000
        } сек)`
      );
    }

    // === Ввод кода ===
    if (code) {
      await randomDelay(humanDelayMin, humanDelayMax);
      log("info", `⌨️ Ввод кода: ${code}`);

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

      await page
        .waitForURL(
          (url) =>
            url.href.includes("cabinet.moyastrana.ru") ||
            url.href.includes("/Account/Login"),
          { timeout: 30000 }
        )
        .catch(() => log("warn", `⚠️ Таймаут редиректа`));

      await randomDelay(5000, 7000);

      // 🔥 ОЧИСТКА ПОЧТЫ ПОСЛЕ УСПЕШНОГО ВВОДА
      log("info", `🧹 Очистка временной почты ${emailAddress}...`);
      await cleanupPostShiftInbox(emailKey, emailAddress, "clear");
    }

    // === Финальный результат ===
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
      emailId: emailKey,
      confirmationCode: code,
      timestamp: new Date().toISOString(),
      url: finalUrl,
    };
  } catch (err) {
    log("error", `❌ Ошибка: ${err.message}`, { stack: err.stack });
    return {
      success: false,
      row,
      email: emailAddress,
      emailId: emailKey,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  } finally {
    // 🔥 Гарантированная очистка в фоне
    if (emailKey && emailAddress) {
      cleanupPostShiftInbox(emailKey, emailAddress, "clear").catch(() => {});
    }
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
  for (const char of text)
    await locator.pressSequentially(char, { delay: Math.random() * 50 + 25 });
};

export default { processRow };
