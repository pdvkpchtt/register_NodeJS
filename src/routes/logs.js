import { Router } from "express";
import { memoryStore } from "../storage/memoryStore.js";

const router = Router();

// 🔥 GET /logs — получение последних логов
router.get("/logs", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = memoryStore.getLogs(limit);

    res.json({
      success: true,
      count: logs.length,
      logs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 DELETE /logs — очистка истории (опционально)
router.delete("/logs", (req, res) => {
  try {
    memoryStore.clearLogs();

    // Уведомляем клиентов через сокет
    const io = req.app.get("socketio");
    if (io) {
      io.emit("logs-cleared", { timestamp: new Date().toISOString() });
    }

    res.json({ success: true, message: "Логи очищены" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
