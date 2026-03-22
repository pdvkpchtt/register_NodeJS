import { Router } from "express";
import { MailSlurp } from "mailslurp-client";
import "dotenv/config";
import * as cheerio from "cheerio"; // Установите: npm install cheerio

const router = Router();

// Функция для извлечения кода из HTML
function extractVerificationCode(htmlContent) {
  // Загружаем HTML в cheerio
  const $ = cheerio.load(htmlContent);

  // Ищем текст, содержащий фразу с кодом
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

// GET
router.get("/email", async (req, res) => {
  const mailslurp = new MailSlurp({
    apiKey: process.env.EMAIL_API,
    timeout: 30000,
  });

  const emailPagination = await mailslurp.emailController.getEmailsPaginated({
    inboxId: "26483136-dcce-4da9-a937-5fd9e22f7b0e",
    sort: "DESC",
    page: 0,
    size: 10,
  });

  const emails = emailPagination.content || [];

  console.log(`📨 Писем в инбоксе: ${emails.length}`);

  if (emails.length > 0) {
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];

      // Получаем полное письмо
      const fullEmail = await mailslurp.emailController.getEmail({
        emailId: email.id,
      });

      console.log(`\n📧 Письмо ${i + 1}:`);
      console.log(`   От: ${fullEmail.from}`);
      console.log(`   Тема: ${fullEmail.subject}`);

      // Извлекаем код подтверждения
      const result = extractVerificationCode(fullEmail.body);

      if (result.success) {
        console.log(`   ✅ Найдена фраза: "${result.fullPhrase}"`);
        console.log(`   🔑 Код подтверждения: ${result.code}`);

        // Здесь можно сохранить код в базу данных или использовать дальше
        // await saveVerificationCode(result.code);
      } else {
        console.log(`   ❌ ${result.message}`);
      }
    }
  } else {
    console.log("   (пока нет писем)");
  }

  res.send("ok");
});

export default router;
