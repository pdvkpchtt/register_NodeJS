import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { FreecustomEmailClient } from "freecustom-email";
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

  // 0) Жесткий матч по точной фразе из письма
  const strictRegex =
    /Для подтверждения регистрации учетной записи введи код подтверждения\.\s*(\d{4})/i;
  const strictMatch = text.match(strictRegex);
  if (strictMatch?.[1]) {
    const code = strictMatch[1];
    console.log(`✅ Код (по строгой фразе) найден: ${code}`);
    return { code, success: true };
  }

  // 0) Самое приоритетное: код после фразы "введи код подтверждения"
  const directPhrase = text.match(
    /(?:введи\s+)?код\s+подтверждения[^\d]{0,40}([0-9]{4,8})/i
  );
  if (directPhrase?.[1]) {
    const code = directPhrase[1];
    console.log(`✅ Код (после фразы) найден: ${code}`);
    return { code, success: true };
  }

  // 1) Ищем около ключевых слов с разделителями
  const keywordRegex =
    /(?:код|code|verification|one[-\s]?time\s?password|otp)[^\dA-Za-z]{0,40}([0-9][0-9\s-]{2,20}[0-9])/i;
  const keywordMatch = text.match(keywordRegex);
  if (keywordMatch?.[1]) {
    const digits = keywordMatch[1].replace(/\D+/g, "");
    if (digits.length >= 4 && digits.length <= 8) {
      console.log(`✅ Код (по ключевым словам) найден: ${digits}`);
      return { code: digits, success: true };
    }
  }

  // 2) Кандидаты из цифр с разделителями
  const digitCandidates = (text.match(/\b[0-9][0-9\s-]{2,20}\b/g) || [])
    .map((c) => c.replace(/\D+/g, ""))
    .filter((c) => c.length >= 4 && c.length <= 8);

  if (digitCandidates.length > 0) {
    const best = digitCandidates.sort((a, b) => b.length - a.length)[0];
    console.log(`✅ Код (по кандидатам цифр) найден: ${best}`);
    return { code: best, success: true };
  }

  // 3) Чистые 4-8 последовательности цифр
  const pureDigits = text.match(/\b\d{4,8}\b/);
  if (pureDigits?.[0]) {
    const around = text.slice(
      Math.max(0, pureDigits.index - 24),
      pureDigits.index + pureDigits[0].length
    );
    if (/регистрац|№/i.test(around)) {
      // пропускаем номер регистрации
    } else {
      console.log(`✅ Код (по чистым цифрам) найден: ${pureDigits[0]}`);
      return { code: pureDigits[0], success: true };
    }
  }

  // 4) Алфанумерик (4-8)
  const alphanum = (text.match(/\b[A-Z0-9]{4,8}\b/gi) || [])
    .map((s) => s.toUpperCase())
    .find((s) => !s.includes("HTTP") && !s.includes("WWW"));
  if (alphanum) {
    console.log(`✅ Код (по алфанумерика) найден: ${alphanum}`);
    return { code: alphanum, success: true };
  }

  console.log(`⚠️ Код не найден в тексте. Доступные паттерны не сработали.`);
  return {
    success: false,
    message: "Код подтверждения не найден",
    preview: text.substring(0, 200),
  };
}

const FREECUSTOM_DEFAULT_DOMAIN = "ditube.info";

let freecustomClient = null;

function getFreecustomClient() {
  if (freecustomClient) return freecustomClient;
  const apiKey = process.env.MY_API_KEY;
  if (!apiKey) throw new Error("MY_API_KEY не настроен в .env");
  freecustomClient = new FreecustomEmailClient({
    apiKey,
    timeout: 20_000,
    retry: { attempts: 2, initialDelayMs: 800 },
  });
  return freecustomClient;
}

function unwrapData(obj) {
  if (!obj) return obj;
  if (typeof obj === "object" && "data" in obj && obj.data) return obj.data;
  return obj;
}

function makeInboxAddress(local, domain) {
  if (!local || String(local).trim() === "") {
    local = `user${Date.now().toString(36)}${Math.random()
      .toString(36)
      .substring(2, 5)}`;
  }

  const safeLocal = String(local)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 24);

  const finalLocal = safeLocal || `user${Date.now().toString(36)}`;

  return `${finalLocal}@${domain}`;
}

async function registerInbox(email) {
  const client = getFreecustomClient();
  const res = await client.inboxes.register(email);
  const data = unwrapData(res);
  return data?.inbox || email;
}

async function createPostShiftEmail(
  name = null,
  domain = FREECUSTOM_DEFAULT_DOMAIN
) {
  const email = makeInboxAddress(
    name || `user${Math.random().toString(36).substring(2, 8)}`,
    domain
  );
  try {
    const registered = await registerInbox(email);
    console.log("📧 Создан inbox freecustom:", { inbox: registered });
    return { email: registered, key: registered };
  } catch (err) {
    const msg = String(err?.message || "");
    const suggestedDomain =
      err?.provided_domains_example ||
      msg.match(/something@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ||
      msg.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1];

    if (suggestedDomain && suggestedDomain !== domain) {
      const fallbackEmail = makeInboxAddress(
        name || `user${Date.now()}`,
        suggestedDomain
      );
      const registered = await registerInbox(fallbackEmail);
      console.log("📧 Создан inbox freecustom (fallback domain):", {
        inbox: registered,
        domain: suggestedDomain,
      });
      return { email: registered, key: registered };
    }
    throw err;
  }
}

async function getPostShiftMessages(inbox) {
  try {
    const client = getFreecustomClient();
    const res = await client.messages.list(String(inbox));
    const data = unwrapData(res);
    const list = Array.isArray(data) ? data : data?.messages;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error("❌ freecustom messages.list failed:", err?.message || err);
    return [];
  }
}

async function getPostShiftMessage(inbox, messageId) {
  try {
    const client = getFreecustomClient();
    const res = await client.messages.get(String(inbox), String(messageId));
    return unwrapData(res) || null;
  } catch (err) {
    console.error("❌ freecustom messages.get failed:", err?.message || err);
    return null;
  }
}

async function cleanupPostShiftInbox(inbox) {
  try {
    const client = getFreecustomClient();
    await client.inboxes.unregister(String(inbox));
    return true;
  } catch {
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

const PROCESS_CANCELLED = "__PROCESS_CANCELLED__";

function assertContinue(shouldContinue) {
  if (!shouldContinue()) {
    const e = new Error(PROCESS_CANCELLED);
    e.code = "PROCESS_CANCELLED";
    throw e;
  }
}

async function randomDelay(min, max, shouldContinue = () => true) {
  const total = Math.random() * (max - min) + min;
  const step = 400;
  let elapsed = 0;
  while (elapsed < total) {
    assertContinue(shouldContinue);
    const chunk = Math.min(step, total - elapsed);
    await new Promise((r) => setTimeout(r, chunk));
    elapsed += chunk;
  }
}

function raceWithCancel(playwrightPromise, shouldContinue) {
  let intervalId;
  const cancelPromise = new Promise((_, reject) => {
    intervalId = setInterval(() => {
      if (!shouldContinue()) {
        clearInterval(intervalId);
        reject(
          Object.assign(new Error(PROCESS_CANCELLED), {
            code: "PROCESS_CANCELLED",
          })
        );
      }
    }, 400);
  });
  return Promise.race([playwrightPromise, cancelPromise]).finally(() => {
    clearInterval(intervalId);
  });
}

// 🔥 Конвертирует дату из Excel (число или строку) в формат "ДД ММ ГГГГ"
function parseExcelDate(value) {
  if (!value) return null;

  // Если уже строка с пробелами — возвращаем как есть
  if (typeof value === "string" && /\d+\s+\d+\s+\d+/.test(value)) {
    return value.trim();
  }

  // Если число (серийный номер даты Excel)
  if (typeof value === "number" && value > 1000 && value < 100000) {
    try {
      // Excel epoch: 30 Dec 1899, но с багом високосного 1900 года
      let days = Math.floor(value);
      let msInDay = 86400000;

      // Базовая дата + дни
      let date = new Date(Date.UTC(1899, 11, 30));
      date.setUTCDate(date.getUTCDate() + days);

      // Исправление бага: Excel считает 1900 високосным, но это не так
      // Все даты >= 60 (после 28.02.1900) нужно сдвинуть на 1 день назад
      if (value >= 60) {
        date.setUTCDate(date.getUTCDate() - 1);
      }

      // Форматируем: "28 7 2002"
      const day = date.getUTCDate();
      const month = date.getUTCMonth() + 1; // 0-based
      const year = date.getUTCFullYear();

      return `${day} ${month} ${year}`;
    } catch (e) {
      console.warn(`⚠️ Не удалось распарсить дату ${value}: ${e.message}`);
      return null;
    }
  }

  // Если строка в другом формате — пробуем распарсить
  if (typeof value === "string") {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return `${date.getDate()} ${date.getMonth() + 1} ${date.getFullYear()}`;
    }
  }

  return String(value).trim();
}

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
    shouldContinue = () => true,
  } = options;

  let emailAddress, emailKey;
  if (externalEmail && externalEmailKey) {
    emailAddress = externalEmail;
    emailKey = externalEmailKey;
  } else {
    await cleanupPostShiftInbox(emailKey);

    const mailNameFromRow =
      row["mail name"] ||
      row["Mail Name"] ||
      row["MAIL NAME"] ||
      row["mail_name"] ||
      row["MailName"] ||
      null;

    const postShift = await createPostShiftEmail(mailNameFromRow);
    emailAddress = postShift.email;
    emailKey = postShift.key;
  }

  const userName = row["Фамилия"] || row["ФАМИЛИЯ"] || "User";
  let browser;
  let formSubmittedSuccessfully = false;

  const log = (level, message, meta = {}) => {
    // 🔥 Фильтр: не показывать debug-логи в консоли (раскомментируйте если нужно)
    // if (level === "debug") return;

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
    assertContinue(shouldContinue);
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
    await raceWithCancel(
      page.goto(loginUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }),
      shouldContinue
    );

    // === Заполнение формы ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Фамилия"]) {
      log("info", `⌨️ Ввод фамилии...`);
      await typeHumanLike(page, familia, row["Фамилия"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Имя"]) {
      log("info", `⌨️ Ввод имени...`);
      await typeHumanLike(page, imya, row["Имя"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Отчество"]) {
      log("info", `⌨️ Ввод отчества...`);
      await typeHumanLike(page, otchestvo, row["Отчество"]);
    }

    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Город"]) {
      log("info", `⌨️ Ввод города...`);
      await typeHumanLike(page, city, row["Город"]);
      await randomDelay(500, 1000, shouldContinue);
      await page.keyboard.press("ArrowDown", { delay: 100 });
      await randomDelay(100, 300, shouldContinue);
      await page.keyboard.press("Enter", { delay: 100 });
      log("info", `✅ Город выбран: ${row["Город"]}`);
    }

    // === Дата рождения ===
    const rawBirthDate = row["Дата рождения"];
    const birthDateStr = parseExcelDate(rawBirthDate + 1);

    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Дата рождения"]) {
      log("info", `⌨️ Ввод даты рождения...`);
      const birthDate = birthDateStr.split(" ");
      const day = birthDate[0],
        month = birthDate[1],
        year = birthDate[2];

      await page.locator(`xpath=${birthDay}`).click({ delay: 200 });
      await randomDelay(200, 500, shouldContinue);
      const dayNum = parseInt(day, 10);
      if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
        for (let i = 0; i < dayNum; i++)
          await page.keyboard.press("ArrowDown", {
            delay: 50 + Math.random() * 50,
          });
        await randomDelay(100, 300, shouldContinue);
        await page.keyboard.press("Enter", { delay: 100 });
        log("info", `✅ День выбран: ${dayNum}`);
      }
      if (month) {
        await randomDelay(200, 400, shouldContinue);
        await page.locator(`xpath=${birthMonth}`).click({ delay: 200 });
        await randomDelay(200, 500, shouldContinue);
        const monthNum = parseInt(month, 10);
        if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
          for (let i = 0; i < monthNum; i++)
            await page.keyboard.press("ArrowDown", {
              delay: 50 + Math.random() * 50,
            });
          await randomDelay(100, 300, shouldContinue);
          await page.keyboard.press("Enter", { delay: 100 });
          log("info", `✅ Месяц выбран: ${monthNum}`);
        }
      }
      if (year) {
        await randomDelay(200, 400, shouldContinue);
        await page.locator(`xpath=${birthYear}`).click({ delay: 200 });
        await randomDelay(200, 500, shouldContinue);
        const yearNum = parseInt(year, 10);
        if (!isNaN(yearNum)) {
          const yearIndex = 2024 - yearNum;
          for (let i = 0; i < yearIndex; i++)
            await page.keyboard.press("ArrowDown", {
              delay: 30 + Math.random() * 30,
            });
          await randomDelay(100, 300, shouldContinue);
          await page.keyboard.press("Enter", { delay: 100 });
          log("info", `✅ Год выбран: ${yearNum}`);
        }
      }
    }

    // === Почта ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (emailAddress) {
      log("info", `⌨️ Ввод почты: ${emailAddress}`);
      await typeHumanLike(page, emailField, emailAddress);
    }

    // === Пароль ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Пароль"]) {
      log("info", `⌨️ Ввод пароля...`);
      await typeHumanLike(page, passwordField, row["Пароль"]);
      await typeHumanLike(page, passwordRepeatField, row["Пароль"]);
    }

    // === Чекбокс ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    log("info", `🖱️ Клик по чекбоксу...`);
    await page.locator(`xpath=${checkBoxOne}`).click({ delay: 200 });

    // === Капча ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    log("info", `🔍 Проверка капчи...`);
    const captchaContainer = page.locator("#yandexSmartCaptchaContainer");
    const captchaCount = await captchaContainer.count().catch(() => 0);
    const captchaVisible = await captchaContainer
      .isVisible()
      .catch(() => false);

    if (captchaCount > 0 && captchaVisible) {
      log("info", `🧩 Yandex SmartCaptcha обнаружена`);
      let token = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        assertContinue(shouldContinue);
        try {
          await captchaContainer.click({
            position: { x: 15, y: 15 },
            delay: 100,
            force: true,
          });
        } catch (e) {
          log("warn", `⚠️ Клик по капче не удался: ${e.message}`);
        }
        token = await page
          .waitForFunction(
            () =>
              document.querySelector('input[name="smart-token"]')?.value
                ?.length > 20,
            { timeout: 5000 }
          )
          .catch(() => null);
        if (token) break;
        await randomDelay(1000, 1500, shouldContinue);
      }
      if (!token) {
        log("warn", `⚠️ Капча не пройдена автоматически`);
        await randomDelay(5000, 8000, shouldContinue);
      }
    }

    // === Отправка формы ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    log("info", `🖱️ Клик по "Продолжить"...`);
    await page.locator(`xpath=${submitButton}`).click({ delay: 200 });

    await page
      .waitForLoadState("networkidle", { timeout: 10000 })
      .catch(() => {});
    const postSubmitUrl = page.url();
    log("debug", `🔗 URL после отправки: ${postSubmitUrl}`);

    // 🔥 ПРОВЕРКА: ушли ли на страницу подтверждения?
    if (postSubmitUrl.includes("/Registration/Confirmation")) {
      log("success", `✅ Форма отправлена успешно — страница подтверждения`);
      formSubmittedSuccessfully = true; // ← 🔥 ВОТ ЭТОГО НЕ ХВАТАЛО!
    } else {
      // Проверка на ошибки валидации
      const errorSelectors = [
        ".error",
        ".validation-error",
        '[class*="error"]',
        ".field-error",
      ];
      let hasErrors = false;
      for (const selector of errorSelectors) {
        const count = await page
          .locator(selector)
          .count()
          .catch(() => 0);
        if (count > 0) {
          hasErrors = true;
          const text = await page
            .locator(selector)
            .first()
            .textContent()
            .catch(() => "")
            .trim();
          log("warn", `⚠️ Ошибка валидации (${selector}): ${text}`);
          break;
        }
      }
      if (hasErrors) {
        log("error", `❌ Форма не отправлена из-за ошибок`);
        formSubmittedSuccessfully = false;
      } else {
        // Неочевидный результат — пробуем дальше
        log("warn", `⚠️ Неочевидный результат отправки, пробуем опрос почты`);
        formSubmittedSuccessfully = true;
      }
    }

    const encodedEmail = encodeURIComponent(emailAddress);

    // 🔥 Прогрев перед опросом почты
    log("info", `⏳ Ждём 10 сек перед опросом почты...`);
    await randomDelay(10000, 10000, shouldContinue);

    // === Параллельное ожидание страницы и опрос почты ===
    const waitConfirmPromise = (async () => {
      if (!formSubmittedSuccessfully) return;
      try {
        await raceWithCancel(
          page.waitForURL(
            (url) =>
              url.href.includes("/Registration/Confirmation") &&
              url.href.includes(`PhoneOrEmail=${encodedEmail}`),
            { timeout: 30000, waitUntil: "load" }
          ),
          shouldContinue
        );
        log("success", `✅ Страница подтверждения загружена`);
      } catch (err) {
        if (err?.code === "PROCESS_CANCELLED") throw err;
        // log("warn", `⚠️ Не удалось дождаться страницу подтверждения`);
      }
    })();

    const pollCodePromise = (async () => {
      if (!formSubmittedSuccessfully) {
        log("warn", `⏭️ Пропускаем опрос почты`);
        return null;
      }

      log("info", `📬 Проверка почты ${emailAddress}...`);
      let code = null;
      const maxAttempts = 40; // 🔥 Увеличено до 40 попыток (~90 сек)
      const pollInterval = 2200;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        assertContinue(shouldContinue);
        try {
          const messages = await getPostShiftMessages(emailKey);
          log(
            "debug",
            `🔍 Попытка ${attempt}/${maxAttempts}: писем: ${messages.length}`
          );

          if (messages.length > 0) {
            log(
              "info",
              `✅ Письма: ${messages.map((m) => m.subject).join(", ")}`
            );

            for (const msg of messages.slice(0, 3)) {
              // 1) Готовый OTP от API
              if (msg?.otp && msg.otp !== "__DETECTED__") {
                code = String(msg.otp);
                log("info", `✅ Код из API: ${code}`);
                break;
              }

              // 2) Парсинг из excerpt/subject
              const combined = `${msg?.mail_excerpt || msg?.excerpt || ""}\n${
                msg?.subject || ""
              }`.trim();

              // 3) Парсинг из полного тела письма
              await randomDelay(800, 800, shouldContinue);
              const fullMsg = await getPostShiftMessage(emailKey, msg?.id);
              const fullText = `${fullMsg?.text || ""}\n${
                fullMsg?.html || ""
              }`.trim();
              const textForParse = fullText || combined;

              const result = extractVerificationCode(textForParse);
              if (result.success) {
                code = result.code;
                log("info", `✅ Код найден: ${code}`);
                break;
              }
            }
            if (code) break;
          }
        } catch (e) {
          log("error", `❌ Ошибка чтения почты: ${e.message}`);
        }
        if (attempt < maxAttempts) {
          await randomDelay(pollInterval, pollInterval, shouldContinue);
        }
      }

      // 🔥 Финальная попытка с увеличенной задержкой
      if (!code) {
        log("info", `🔄 Финальная проверка почты...`);
        await randomDelay(12000, 12000, shouldContinue);
        try {
          const final = await getPostShiftMessages(emailKey);
          for (const msg of final.slice(0, 2)) {
            if (msg?.otp && msg.otp !== "__DETECTED__") {
              code = String(msg.otp);
              break;
            }
            const fullMsg = await getPostShiftMessage(emailKey, msg?.id);
            const fullText = `${fullMsg?.text || ""}\n${
              fullMsg?.html || ""
            }`.trim();
            const result = extractVerificationCode(fullText);
            if (result.success) {
              code = result.code;
              break;
            }
          }
        } catch {}
      }

      if (!code) log("warn", `⚠️ Код не найден после ${maxAttempts} попыток`);
      return code;
    })();

    const code = await pollCodePromise;
    await waitConfirmPromise;

    // === Ввод кода ===
    if (code) {
      await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
      log("info", `⌨️ Ввод кода: ${code}`);

      await page
        .waitForSelector(`xpath=${secondInput}`, {
          state: "visible",
          timeout: 10000,
        })
        .catch(() => log("warn", `⚠️ Поле для кода не найдено`));

      await typeHumanLike(page, secondInput, code);
      await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);

      log("info", `🖱️ Клик по "Подтвердить"...`);
      await page.locator(`xpath=${secondSubmitButton}`).click({ delay: 200 });

      try {
        await raceWithCancel(
          page.waitForURL(
            (url) =>
              url.href.includes("cabinet.moyastrana.ru") ||
              url.href.includes("/Account/Login"),
            { timeout: 30000 }
          ),
          shouldContinue
        );
      } catch (e) {
        if (e?.code !== "PROCESS_CANCELLED")
          log("warn", `⚠️ Таймаут редиректа`);
      }

      await randomDelay(4000, 6000, shouldContinue);
      log("info", `🧹 Очистка почты ${emailAddress}...`);
      await cleanupPostShiftInbox(emailKey);
    } else {
      log("warn", `⚠️ Код не найден, пропускаем ввод`);
    }

    // === Финальный результат ===
    const finalUrl = page.url();
    const trulySucceeded = !!(
      code && finalUrl.includes("cabinet.moyastrana.ru")
    );
    const completed = trulySucceeded ? "да" : "нет";

    log(
      trulySucceeded ? "success" : "warn",
      `🎯 Результат: ${
        trulySucceeded ? "✅ Успех" : "❌ Неудача"
      } | Завершено: ${completed}`
    );

    return {
      success: trulySucceeded,
      completed, // 🔥 "да" или "нет"
      row,
      email: emailAddress,
      emailId: emailKey,
      confirmationCode: code,
      timestamp: new Date().toISOString(),
      url: finalUrl,
      debug: {
        codeFound: !!code,
        formSubmitted: formSubmittedSuccessfully,
        finalUrl,
      },
    };
  } catch (err) {
    if (
      err?.code === "PROCESS_CANCELLED" ||
      err?.message === PROCESS_CANCELLED
    ) {
      log("warn", "🛑 Остановлено пользователем");
      return {
        success: false,
        completed: "нет",
        cancelled: true,
        row,
        email: emailAddress,
        emailId: emailKey,
        timestamp: new Date().toISOString(),
      };
    }
    log("error", `❌ Ошибка: ${err.message}`, { stack: err.stack });
    return {
      success: false,
      completed: "нет",
      row,
      email: emailAddress,
      emailId: emailKey,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (emailKey) cleanupPostShiftInbox(emailKey).catch(() => {});
    if (browser) {
      await browser.close();
      log("info", `🔚 Браузер закрыт`);
    }
  }
};

const typeHumanLike = async (page, xpath, text) => {
  const locator = page.locator(`xpath=${xpath}`);
  await locator.focus();
  for (const char of text)
    await locator.pressSequentially(char, { delay: Math.random() * 50 + 25 });
};

export default { processRow };
