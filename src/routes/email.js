import { Router } from "express";
import axios from "axios";

const router = Router();

const POST_SHIFT_HASH = process.env.POST_SHIFT_HASH;

// 🔹 GET / — создать почту и вывести содержимое ящика (просто JSON)
router.get("/email", async (req, res) => {
  try {
    if (!POST_SHIFT_HASH) {
      return res
        .status(500)
        .json({ error: "POST_SHIFT_HASH не настроен в .env" });
    }

    // 1️⃣ Генерируем случайное имя для почты
    const emailName = `user${Math.random().toString(36).substring(2, 8)}`;

    // 2️⃣ Создаем временную почту через API post-shift.ru
    const createRes = await axios.get("https://post-shift.ru/api.php", {
      params: {
        action: "new",
        hash: POST_SHIFT_HASH,
        name: emailName,
        domain: "post-shift.ru",
      },
      timeout: 10000,
    });

    const { email, key } = createRes.data;
    if (!email || !key) {
      return res
        .status(500)
        .json({ error: "Не удалось создать почту", raw: createRes.data });
    }

    // 3️⃣ Получаем список писем
    const messagesRes = await axios.get("https://post-shift.ru/api.php", {
      params: {
        action: "getlist",
        hash: POST_SHIFT_HASH,
        key,
      },
      timeout: 10000,
    });

    const messages = Array.isArray(messagesRes.data) ? messagesRes.data : [];

    // 4️⃣ 🔥 Возвращаем ПРОСТОЙ JSON — без верстки
    res.json({
      email,
      key,
      messages,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Ошибка:", err.message);
    res.status(500).json({
      error: "Ошибка при работе с почтой",
      details: err.response?.data || err.message,
    });
  }
});

export default router;
