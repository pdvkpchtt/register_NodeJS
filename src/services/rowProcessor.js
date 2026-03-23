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
  // Пример: "Для подтверждения ... введи код подтверждения. 1946"
  const directPhrase = text.match(
    /(?:введи\s+)?код\s+подтверждения[^\d]{0,40}([0-9]{4,8})/i
  );
  if (directPhrase?.[1]) {
    const code = directPhrase[1];
    console.log(`✅ Код (после фразы) найден: ${code}`);
    return { code, success: true };
  }

  // 1) Сначала ищем около ключевых слов и допускаем разделители (пробел/дефис)
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

  // 2) Дальше ищем любые "кандидаты" из цифр/букв (4-8), но сначала пробуем нормализовать цифры
  const digitCandidates = (text.match(/\b[0-9][0-9\s-]{2,20}\b/g) || [])
    .map((c) => c.replace(/\D+/g, ""))
    .filter((c) => c.length >= 4 && c.length <= 8);

  if (digitCandidates.length > 0) {
    const best = digitCandidates.sort((a, b) => b.length - a.length)[0];
    console.log(`✅ Код (по кандидатам цифр) найден: ${best}`);
    return { code: best, success: true };
  }

  // 3) Ищем "чистые" 4-8 последовательности цифр
  const pureDigits = text.match(/\b\d{4,8}\b/);
  if (pureDigits?.[0]) {
    // Защита от ложного срабатывания на "Подтверждение регистрации №1998"
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

  // 4) Наконец, пробуем алфанумерик (4-8) рядом/в тексте
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
  // некоторые методы SDK могут возвращать { success, data: ... }
  if (typeof obj === "object" && "data" in obj && obj.data) return obj.data;
  return obj;
}

function makeInboxAddress(local, domain) {
  // 🔥 Если local пустой — генерируем уникальный, но читаемый идентификатор
  if (!local || String(local).trim() === '') {
    local = `user${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`;
  }
  
  // 🔥 Санитизация: только латиница, цифры, . _ -
  const safeLocal = String(local)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')  // Удаляем всё лишнее
    .replace(/^[._-]+|[._-]+$/g, '')  // Убираем спецсимволы по краям
    .replace(/\.{2,}/g, '.')  // Заменяем множественные точки на одну
    .slice(0, 24);  // Ограничение API: макс. 24 символа
  
  // 🔥 Если после санитизации строка пустая — генерируем заново
  const finalLocal = safeLocal || `user${Date.now().toString(36)}`;
  
  return `${finalLocal}@${domain}`;
}

async function registerInbox(email) {
  const client = getFreecustomClient();
  const res = await client.inboxes.register(email);
  const data = unwrapData(res);
  return data?.inbox || email;
}

async function createPostShiftEmail(name = null, domain = FREECUSTOM_DEFAULT_DOMAIN) {
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
    // В ошибке часто есть пример домена / upgrade_url
    const suggestedDomain =
      err?.provided_domains_example ||
      msg.match(/something@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ||
      msg.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1];

    if (suggestedDomain && suggestedDomain !== domain) {
      const fallbackEmail = makeInboxAddress(name || `user${Date.now()}`, suggestedDomain);
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
  headless: true,
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-gpu", // Рекомендуется для headless режима
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

/** Прерывает ожидание Playwright при нажатии «Стоп» (memoryStore.isProcessing → false) */
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
    /** Вызывается из parse-stream: пока true — продолжаем строку; «Стоп» снимает флаг в memoryStore */
    shouldContinue = () => true,
  } = options;

  let emailAddress, emailKey;
  if (externalEmail && externalEmailKey) {
    emailAddress = externalEmail;
    emailKey = externalEmailKey;
  } else {
    cleanupPostShiftInbox();
    
    // 🔥 Берём имя почты из Excel: приоритет row['mail name'] (регистронезависимо)
    const mailNameFromRow = 
      row['mail name'] || 
      row['Mail Name'] || 
      row['MAIL NAME'] || 
      row['mail_name'] || 
      row['MailName'] ||
      null;
    
    const postShift = await createPostShiftEmail(mailNameFromRow);  // ✅ Передаём имя из Excel
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
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    if (row["Дата рождения"]) {
      log("info", `⌨️ Ввод даты рождения...`);
      const birthDate = row["Дата рождения"].split(" ");
      const day = birthDate[0],
        month = birthDate[1],
        year = birthDate[2];

      // День
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
      // Месяц
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
      // Год
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
    const captchaVisible = await captchaContainer.isVisible().catch(() => false);

    log("debug", `🧩 SmartCaptcha: present=${captchaCount > 0}, visible=${captchaVisible}`);

    if (captchaCount > 0) {
      if (captchaVisible) log("info", `🧩 Yandex SmartCaptcha обнаружена`);
      // Делаем несколько попыток кликнуть, т.к. у SmartCaptcha часто бывает оверлей/iframe.
      let token = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        assertContinue(shouldContinue);
        try {
          await captchaContainer.click({
            position: { x: 15, y: 15 },
            delay: 100,
            force: true,
          });
          log("info", `🖱️ Капча: клик попытка ${attempt}/3`);
        } catch (e) {
          log("warn", `⚠️ Не удалось кликнуть капчу (попытка ${attempt}/3): ${e.message}`);
        }

        token = await page
          .waitForFunction(
            () =>
              document.querySelector('input[name="smart-token"]')?.value?.length >
              20,
            { timeout: 5000 }
          )
          .catch(() => null);

        if (token) break;
        await randomDelay(1000, 1500, shouldContinue);
      }

      if (token) log("info", `✅ Капча пройдена`);
      else {
        log("warn", `⚠️ Капча не пройдена автоматически`);
        await randomDelay(5000, 10000, shouldContinue);
      }
    }

    // === Отправка ===
    await randomDelay(humanDelayMin, humanDelayMax, shouldContinue);
    log("info", `🖱️ Клик по "Продолжить"...`);
    await page.locator(`xpath=${submitButton}`).click({ delay: 200 });

    const encodedEmail = encodeURIComponent(emailAddress);

    // Запускаем ожидание подтверждения и поллинг почты параллельно,
    // чтобы успеть получить код до протухания inbox.
    const waitConfirmPromise = (async () => {
      log("info", `⏳ Ожидание перехода на страницу подтверждения...`);
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
        log(
          "warn",
          `⚠️ Не удалось дождаться по email, пробуем общий паттерн...`
        );
        try {
          await raceWithCancel(
            page.waitForURL(
              (url) => url.href.includes("/Registration/Confirmation"),
              { timeout: 15000, waitUntil: "domcontentloaded" }
            ),
            shouldContinue
          );
          log("success", `✅ Страница подтверждения загружена (общий паттерн)`);
        } catch (err2) {
          if (err2?.code === "PROCESS_CANCELLED") throw err2;
          log("error", `❌ Не удалось дождаться: ${err2.message}`);
        }
      }
    })();

    const pollCodePromise = (async () => {
      log("info", `📬 Проверка почты ${emailAddress}...`);

      let code = null;
      const maxAttempts = 30; // 🔥 90 секунд ожидания
      // Free plan: 1 req/s. Держим запас, чтобы не упираться в лимиты.
      const pollInterval = 2200;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        assertContinue(shouldContinue);
        try {
          const messages = await getPostShiftMessages(emailKey);

          log(
            "debug",
            `🔍 Попытка ${attempt}/${maxAttempts}: найдено писем: ${messages.length}`
          );

          if (messages.length > 0) {
            log(
              "info",
              `✅ Письма получены: ${messages
                .map((m) => m.subject)
                .join(", ")}`
            );

            // Письем может прийти несколько; иногда код не в самом первом.
            // На Free плане нельзя делать messages.get (лимит 1 req/s), поэтому извлекаем из метаданных.
            const candidates = messages.slice(0, 3);
            for (const msg of candidates) {
              // 1) Если API уже извлёк OTP — берём его напрямую
              if (msg?.otp && msg.otp !== "__DETECTED__") {
                code = String(msg.otp);
                log("info", `✅ Код найден (otp): ${code}`);
                break;
              }

              const excerpt = msg?.mail_excerpt || msg?.excerpt || "";
              const subject = msg?.subject || "";
              // На free-плане ориентируемся прежде всего на excerpt (там чаще есть код),
              // subject может содержать номер регистрации вместо OTP.
              const combined = `${excerpt}\n${subject}`.trim();

              console.log("📩 Содержимое письма (для парсинга кода):", {
                id: msg?.id,
                from: msg?.from,
                subject,
                excerpt,
                otp: msg?.otp,
                combinedPreview: combined.substring(0, 500),
              });

              // 2) Тянем полное письмо и ищем код в body (там часто нужная фраза с кодом).
              // Перед messages.get выдерживаем паузу, чтобы не словить 1 req/s лимит.
              await randomDelay(1200, 1200, shouldContinue);
              const fullMsg = await getPostShiftMessage(emailKey, msg?.id);
              const fullText = `${fullMsg?.text || ""}\n${fullMsg?.html || ""}`.trim();

              if (fullText) {
                console.log("📨 Полный текст письма (preview):", {
                  id: msg?.id,
                  fullPreview: fullText.substring(0, 1000),
                });
              }

              const textForRegex = fullText || combined;
              const result = extractVerificationCode(textForRegex);
              if (result.success) {
                code = result.code;
                log("info", `✅ Код найден: ${code}`);
                break;
              }
            }

            if (code) break;
          }
        } catch (e) {
          log("error", `❌ Ошибка при чтении почты: ${e.message}`);
        }

        if (attempt < maxAttempts) {
          await randomDelay(pollInterval, pollInterval, shouldContinue);
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

      return code;
    })();

    // Ждём оба ожидания, но код забираем из pollCodePromise
    const code = await pollCodePromise;
    await waitConfirmPromise;

    const currentUrl = page.url();
    log("debug", `🔗 Текущий URL: ${currentUrl}`);

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
        if (e?.code === "PROCESS_CANCELLED") throw e;
        log("warn", `⚠️ Таймаут редиректа`);
      }

      await randomDelay(5000, 7000, shouldContinue);

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
    if (err?.code === "PROCESS_CANCELLED" || err?.message === PROCESS_CANCELLED) {
      log("warn", "🛑 Остановлено пользователем (кнопка «Стоп»)");
      return {
        success: false,
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

const typeHumanLike = async (page, xpath, text) => {
  const locator = page.locator(`xpath=${xpath}`);
  await locator.focus();
  for (const char of text)
    await locator.pressSequentially(char, { delay: Math.random() * 50 + 25 });
};

export default { processRow };
