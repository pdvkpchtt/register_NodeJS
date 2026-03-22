import { Router } from "express";
import { memoryStore } from "../storage/memoryStore.js";

const router = Router();

router.get("/settings", (req, res) => {
  res.json({ success: true, settings: memoryStore.getSettings() });
});

router.put("/settings", (req, res) => {
  try {
    const newSettings = req.body;

    // Валидация
    if (newSettings.duration !== undefined) {
      const duration = parseInt(newSettings.duration);
      if (isNaN(duration) || duration < 1 || duration > 60) {
        return res.status(400).json({ error: "duration: 1-60 минут" });
      }
    }

    memoryStore.setSettings(newSettings);

    // Рассылаем обновление всем клиентам
    const io = req.app.get("socketio");
    if (io) {
      io.emit("settings-sync", { settingsForm: memoryStore.getSettings() });
    }

    res.json({
      success: true,
      message: "Настройки сохранены",
      settings: memoryStore.getSettings(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
