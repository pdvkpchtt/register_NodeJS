import { Router } from "express";
import { memoryStore } from "../storage/memoryStore.js";

const router = Router();

// GET / — главная страница / информация о файле
router.get("/", async (req, res) => {
  // 📥 Скачивание файла: ?download=1
  if (req.query.download === "1" && memoryStore.has("file")) {
    const file = memoryStore.get("file");
    res.setHeader("Content-Type", file.mimetype);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.originalname)}"`
    );
    res.setHeader("Content-Length", file.size);
    return res.send(file.buffer);
  }

  if (req.query.settings === "1") {
    const settings = memoryStore.getSettings();
    return res.json({ settings });
  }

  // 📋 Метаданные: ?info=1
  if (req.query.info === "1") {
    const file = memoryStore.get("file");
    if (!file) {
      return res.json({ file: null });
    }
    return res.json({
      file: {
        name: file.originalname,
        size: file.size,
        type: file.mimetype,
        uploadedAt: file.uploadedAt,
      },
    });
  }

  // 👇 По умолчанию — возвращаем инфо о последнем файле
  try {
    const file = memoryStore.get("file");
    res.json({
      lastFile: file
        ? {
            name: file.originalname,
            size: file.size,
            uploadedAt: file.uploadedAt,
          }
        : null,
    });
  } catch (err) {
    console.error("Error in GET /:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
