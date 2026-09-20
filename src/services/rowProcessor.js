import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import { FreecustomEmailClient } from "freecustom-email";
import { Solver } from "2captcha-ts";
import "dotenv/config";
import * as cheerio from "cheerio";
import fs from "fs";
import sharp from "sharp";

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
// Ваши кастомные домены
const customDomains = ["googlu.ru", "maaiil.ru", "yaanndex.ru"];
// Функция для выбора случайного элемента из массива
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

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

  // 🔥 ИСПОЛЬЗУЕМ переданный domain, если есть
  const finalDomain = domain;

  const finalLocal = safeLocal || `user${Date.now().toString(36)}`;

  return `${finalLocal}@${finalDomain}`; // ← ✅ Теперь домен корректный
}

async function registerInbox(email) {
  const client = getFreecustomClient();
  const res = await client.inboxes.register(email);
  const data = unwrapData(res);
  return data?.inbox || email;
}

async function createPostShiftEmail(
  name = null,
  domain = getRandomElement(customDomains)
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

const BROWSER_CONFIG =
  process.env.NODE_ENV === "production"
    ? {
        headless: true, // 🔥 Меняем false → true (или "new" для нового режима)
        viewport: { width: 1920, height: 1920 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          // 🔥 Дополнительные флаги для стабильного headless-режима:
          "--disable-gpu", // Отключаем GPU (не нужен в headless)
          "--disable-software-rasterizer",
          "--disable-setuid-sandbox",
        ],
      }
    : {
        headless: false, // 🔥 Меняем false → true (или "new" для нового режима)
        viewport: { width: 1920, height: 1920 },
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
    loginUrl = "https://lift-bf.ru/contest/ocean?z=register",
    familia = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[1]/div/input",
    imya = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[2]/div/input",
    otchestvo = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/div[1]/div/label[1]/div/input",
    city = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/div[3]/span[2]",
    cityChoose = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/div[3]/div/ul/li[1]/div",
    birthDay = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[3]/div/input",
    phoneField = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[4]/div/input",
    emailField = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[5]/div/input",
    passwordField = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[7]/div/input",
    passwordRepeatField = "/html/body/div[1]/div[1]/div/div/div/form/div[1]/label[8]/div/input",
    checkBoxOne = "/html/body/div[1]/div[1]/div/div/div/form/label[1]/span[2]/div/span",
    checkBoxTwo = "/html/body/div[1]/div[1]/div/div/div/form/label[2]/span[2]/div/span",
    submitButton = "/html/body/div[1]/div[1]/div/div/div/form/div[2]/button",
    secondInput = "/html/body/div[5]/div[1]/div/div/div/form/div[1]/input",
    secondSubmitButton = "/html/body/div[5]/div[1]/div/div/div/form/div[3]/button",
    captha = "/html/body/div[2]/div[2]/div/div/div/div/div/div[1]/div/img",
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
    // await cleanupPostShiftInbox(emailKey);

    const mailNameFromRow =
      row["mail name"] ||
      row["Mail Name"] ||
      row["MAIL NAME"] ||
      row["mail_name"] ||
      row["MailName"] ||
      null;

    // const postShift = await createPostShiftEmail(mailNameFromRow);
    // emailAddress = postShift.email;
    // emailKey = postShift.key;
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
      recordVideo: {
        dir: "videos",
        size: BROWSER_CONFIG.viewport, // Должно совпадать с viewport для идеальной картинки
      },
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
      await clickAndTypeHumanLike(page, city, row["Город"]);
      await randomDelay(2000, 2500, shouldContinue);
      page.locator(`xpath=${cityChoose}`).click({ delay: 200 });

      log("info", `✅ Город выбран: ${row["Город"]}`);
    }

    // === Дата рождения ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    const bday = randomBirthDate();
    log("info", `⌨️ Ввод даты рождения..., ${bday}`);
    page.locator(`xpath=${birthDay}`).fill(bday);

    // === Телефон ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Телефон"]) {
      log("info", `⌨️ Ввод телефона...`);
      await typeHumanLike(page, phoneField, row["Телефон"]);
    }

    // === Почта ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    const emailAddress = row["Почта"];
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
    await page.locator(`xpath=${checkBoxTwo}`).click({ delay: 200 });

    // === Отправка формы ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    log("info", `🖱️ Клик по "Продолжить"...`);
    await page.locator(`xpath=${submitButton}`).click({ delay: 200 });
    await randomDelay(1000, 3000, shouldContinue);

    log("debug", `🔗 Форма отправлена`);

    // === РЕШЕНИЕ YANDEX SMARTCAPTCHA (МЕТОД СКРИНШОТА) ===
    // === РЕШЕНИЕ YANDEX SMARTCAPTCHA (СКРИН ВСЕЙ СТРАНИЦЫ) ===
    // === РЕШЕНИЕ YANDEX SMARTCAPTCHA ===
    // === РЕШЕНИЕ YANDEX SMARTCAPTCHA (СКРИН С КВАДРАТАМИ) ===
    log("info", `🔍 Решение капчи...`);
    try {
      const viewport = page.viewportSize();
      if (!viewport) throw new Error("Не удалось получить размеры viewport");

      const captchaWidth = 500;
      const captchaHeight = 500;
      const clipX = Math.floor((viewport.width - captchaWidth) / 2);
      const clipY = Math.floor((viewport.height - captchaHeight) / 2);

      const clipRegion = {
        x: clipX,
        y: clipY,
        width: captchaWidth,
        height: captchaHeight,
      };

      log(
        "debug",
        `📸 Область капчи: x=${clipX}, y=${clipY}, w=${captchaWidth}, h=${captchaHeight}`
      );

      // Скриншоты для отладки
      const screenshotFull = await page.screenshot({
        type: "png",
        fullPage: false,
      });
      fs.writeFileSync("screen_full.png", screenshotFull);

      const screenshot = await page.screenshot({
        type: "png",
        clip: clipRegion,
      });
      fs.writeFileSync("captcha_full.png", screenshot);

      // 2captcha
      // === 🔥 ПОВТОРНАЯ ОТПРАВКА В 2CAPTCHA ПРИ НЕВЕРНОМ ОТВЕТЕ ===
      const solver = new Solver(process.env.API_KEY);
      let result = null;
      const maxRetries = 3; // Максимум 3 попытки
      let attempt = 0;

      while (attempt < maxRetries) {
        attempt++;
        log(
          "info",
          `🔄 Отправка в 2captcha (попытка ${attempt}/${maxRetries})...`
        );

        result = await solver.coordinates({
          body: screenshot.toString("base64"),
          lang: "ru",
        });

        log("info", `✅ Ответ от 2captcha: ${JSON.stringify(result.data)}`);

        // Проверяем, что точек больше 1 (для Яндекса обычно нужно 2-5 точек)
        if (result.data && result.data.length > 1) {
          log(
            "info",
            `✅ Получено корректное количество точек: ${result.data.length}`
          );
          break; // Всё хорошо, выходим из цикла
        } else {
          log(
            "warn",
            `⚠️ Неверное количество точек (${
              result.data ? result.data.length : 0
            }). Повторная попытка...`
          );
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1500)); // Пауза перед повтором
          }
        }
      }

      // Если после всех попыток точек всё ещё <= 1, выбрасываем ошибку
      if (!result || !result.data || result.data.length <= 1) {
        throw new Error(
          `Не удалось получить корректные координаты после ${maxRetries} попыток. Последний ответ: ${JSON.stringify(
            result?.data
          )}`
        );
      }

      log("info", `✅ Координаты получены: ${JSON.stringify(result.data)}`);

      // Рисуем квадраты на скринах для проверки
      try {
        const overlays = result.data.map((coord) => {
          const x = parseInt(coord.x);
          const y = parseInt(coord.y);
          return {
            input: {
              create: {
                width: 40,
                height: 40,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 0.6 },
              },
            },
            top: y - 20,
            left: x - 20,
          };
        });
        await sharp(screenshot)
          .composite(overlays)
          .toFile("captcha_center_with_squares.png");
      } catch (drawErr) {
        log("warn", `⚠️ Ошибка рисования квадратиков: ${drawErr.message}`);
      }

      // === КЛИКИ С ВИЗУАЛИЗАЦИЕЙ ===
      log("info", `🖱️ Начинаем клики с визуализацией...`);

      for (let i = 0; i < result.data.length; i++) {
        const coord = result.data[i];

        // Чистая математика: начало области + координата от 2captcha
        const x = clipX + parseInt(coord.x);
        const y = clipY + parseInt(coord.y);

        log(
          "info",
          `🖱️ Клик ${i + 1}/${result.data.length}: Абсолютные (${x}, ${y})`
        );

        // === ВИЗУАЛИЗАЦИЯ КРУЖКА (Playwright запишет это на видео!) ===
        await page.evaluate(
          ({ clickX, clickY, clickNumber }) => {
            const circle = document.createElement("div");
            circle.style.position = "fixed";
            circle.style.left = clickX - 25 + "px";
            circle.style.top = clickY - 25 + "px";
            circle.style.width = "50px";
            circle.style.height = "50px";
            circle.style.borderRadius = "50%";
            circle.style.border = "4px solid #ff0000";
            circle.style.background = "rgba(255, 0, 0, 0.5)";
            circle.style.zIndex = "99999999";
            circle.style.pointerEvents = "none";
            circle.style.display = "flex";
            circle.style.alignItems = "center";
            circle.style.justifyContent = "center";

            const numberSpan = document.createElement("span");
            numberSpan.textContent = clickNumber;
            numberSpan.style.color = "#fff";
            numberSpan.style.fontWeight = "bold";
            numberSpan.style.fontSize = "20px";
            circle.appendChild(numberSpan);

            // Анимация пульсации
            circle.animate(
              [
                { transform: "scale(1)" },
                { transform: "scale(1.4)" },
                { transform: "scale(1)" },
              ],
              { duration: 400, iterations: 2 }
            );

            document.body.appendChild(circle);

            // Плавное исчезновение
            setTimeout(() => {
              circle.style.transition = "opacity 0.5s";
              circle.style.opacity = "0";
              setTimeout(() => circle.remove(), 500);
            }, 1500);
          },
          { clickX: x, clickY: y, clickNumber: i + 1 }
        );

        // Пауза, чтобы кружок успел отрисоваться в кадре видео перед кликом
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Сам клик
        await page.mouse.click(x, y);

        // Human delay между кликами
        await randomDelay(3000, 5000, shouldContinue);
      }

      log("info", `✅ Все точки нажаты`);
      await randomDelay(1000, 1500, shouldContinue);

      // Клик по кнопке "Отправить"
      const btnX = clipX + captchaWidth / 2 + 30;
      const btnY = clipY + captchaHeight - 144;

      // Визуализация зеленой кнопки SEND
      // Визуализация зеленой кнопки SEND
      await page.evaluate(
        ({ clickX, clickY }) => {
          const btnCircle = document.createElement("div");
          btnCircle.style.position = "fixed";
          btnCircle.style.left = clickX - 30 + "px";
          btnCircle.style.top = clickY - 30 + "px";
          btnCircle.style.width = "60px";
          btnCircle.style.height = "60px";
          btnCircle.style.borderRadius = "50%";
          btnCircle.style.border = "4px solid #00ff00";
          btnCircle.style.background = "rgba(0, 255, 0, 0.5)";
          btnCircle.style.zIndex = "99999999";
          btnCircle.style.pointerEvents = "none";
          btnCircle.style.display = "flex";
          btnCircle.style.alignItems = "center";
          btnCircle.style.justifyContent = "center";

          const textSpan = document.createElement("span");
          textSpan.textContent = "SEND";
          textSpan.style.color = "#000";
          textSpan.style.fontWeight = "900";
          textSpan.style.fontSize = "14px";
          btnCircle.appendChild(textSpan);

          document.body.appendChild(btnCircle);
          setTimeout(() => {
            btnCircle.style.transition = "opacity 0.5s";
            btnCircle.style.opacity = "0";
            setTimeout(() => btnCircle.remove(), 500);
          }, 1500);
        },
        { clickX: btnX, clickY: btnY }
      );

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Сам клик
      await page.mouse.click(btnX, btnY);
      log("info", `✅ Клик по кнопке "Отправить" выполнен`);
      await randomDelay(10000, 20000, shouldContinue);

      // 🔥 КРИТИЧЕСКИ ВАЖНО: Даем время видео-рекордеру захватить кадры ПОСЛЕ клика,
      // прежде чем мы начнем закрывать браузер
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // === ПРАВИЛЬНОЕ СОХРАНЕНИЕ ВИДЕО ===
      log("info", `💾 Подготовка к сохранению видео...`);

      // 1. Получаем объект видео ПОКА контекст еще открыт
      const video = page.video();

      if (video) {
        try {
          // 2. Создаем папку, если нет
          if (!fs.existsSync("videos")) {
            fs.mkdirSync("videos", { recursive: true });
          }

          const finalVideoName = `videos/captcha_solve_${Date.now()}.webm`;

          // 3. ЗАКРЫВАЕМ контекст. Это финализирует запись видео-файла!
          log("info", `🔚 Закрытие контекста для финализации видео...`);
          await context.close();

          // 4. ТЕПЕРЬ сохраняем видео из временной папки в нашу
          await video.saveAs(finalVideoName);
          log("info", `🎥 ВИДЕО УСПЕШНО СОХРАНЕНО: ${finalVideoName}`);
        } catch (saveErr) {
          log("error", `❌ Ошибка при сохранении видео: ${saveErr.message}`);
          // На случай ошибки все равно закрываем контекст
          await context.close().catch(() => {});
        }
      } else {
        log(
          "warn",
          `⚠️ Видео не было записано. Проверь настройки browser.newContext`
        );
        await context.close().catch(() => {});
      }

      log("info", `✅ Капча решена`);
      await randomDelay(1000, 2000, shouldContinue);
    } catch (err) {
      log("warn", `⚠️ Ошибка капчи: ${err.message}`);

      // Сохраняем видео даже при ошибке, чтобы посмотреть, где сломалось
      const video = page.video();
      if (video) {
        try {
          if (!fs.existsSync("videos"))
            fs.mkdirSync("videos", { recursive: true });
          const finalVideoName = `videos/captcha_ERROR_${Date.now()}.webm`;

          await context.close().catch(() => {}); // Сначала закрываем
          await video.saveAs(finalVideoName); // Потом сохраняем

          log("info", `🎥 Видео с ошибкой сохранено: ${finalVideoName}`);
        } catch (e) {
          log("error", `Не удалось сохранить видео с ошибкой: ${e.message}`);
        }
      } else {
        await context.close().catch(() => {});
      }
    }
    // сюда код

    log("debug", `😁👍 Капча решена`);
    await randomDelay(1000, 3000, shouldContinue);

    // === Финальный результат ===
    // === Финальный результат ===
    const finalUrl = page.url();
    const isCorrectUrl = finalUrl === "https://lift-bf.ru/contest/ocean";
    log("debug", `🤷‍♂️ cleanUrl - ${finalUrl}`);

    const trulySucceeded = !!isCorrectUrl;
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
      timestamp: new Date().toISOString(),
      url: finalUrl,
      debug: {
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
        timestamp: new Date().toISOString(),
      };
    }
    log("error", `❌ Ошибка: ${err.message}`, { stack: err.stack });
    return {
      success: false,
      completed: "нет",
      row,
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

const clickAndTypeHumanLike = async (page, xpath, text) => {
  const locator = page.locator(`xpath=${xpath}`);
  await locator.click({ delay: 200 });
  for (const char of text)
    await locator.pressSequentially(char, { delay: Math.random() * 50 + 25 });
};

function randomBirthDate(fromYear = 1996, toYear = 2005) {
  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear, 11, 31, 23, 59, 59, 999);
  const ts = start + Math.random() * (end - start);
  const d = new Date(ts);

  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export default { processRow };
