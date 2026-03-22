import { Router } from "express";

import { upload, handleMulterError } from "../middleware/upload.js";
import { memoryStore } from "../storage/memoryStore.js";

const router = Router();

// POST /upload — загрузка файла
router.post("/upload", upload.single("file"), (req, res) => {
  try {
    console.log("=== 📁 Получен файл ===");
    console.log("Имя файла:", req.file?.originalname);
    console.log("MIME-тип:", req.file?.mimetype);
    console.log("Размер:", req.file?.size, "bytes");

    // Сохраняем в память
    memoryStore.set("file", {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
    });

    res.json({
      success: true,
      message: "Файл успешно получен",
      filename: req.file?.originalname,
    });
  } catch (err) {
    console.error("Error uploading file:", err);
    res.status(500).json({ error: "Ошибка при загрузке файла" });
  }
});

// 🗑️ DELETE /upload — удаление файла
router.delete("/upload", (req, res) => {
  try {
    if (!memoryStore.has("file")) {
      return res.status(404).json({ error: "Файл не найден" });
    }

    const deletedFile = memoryStore.get("file");
    memoryStore.clear("file"); // Очищаем хранилище

    console.log("=== 🗑️ Файл удалён ===");
    console.log("Имя:", deletedFile.originalname);

    res.json({
      success: true,
      message: "Файл успешно удалён",
      filename: deletedFile.originalname,
    });
  } catch (err) {
    console.error("Error deleting file:", err);
    res.status(500).json({ error: "Ошибка при удалении файла" });
  }
});

// Экспортируем обработчик ошибок отдельно для подключения в main
export const uploadErrorMiddleware = handleMulterError;

export default router;
