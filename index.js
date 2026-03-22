import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { memoryStore } from "./src/storage/memoryStore.js";

/** Локальная разработка + origin из .env / панели хостинга (через запятую) */
function getAllowedOrigins() {
  const defaults = ["http://localhost:5173", "http://127.0.0.1:5173"];
  const raw = [process.env.FRONT_ORIGIN, process.env.CORS_ORIGINS]
    .filter(Boolean)
    .join(",");
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return [...new Set([...defaults, ...fromEnv])];
}

const allowedOrigins = getAllowedOrigins();

function isOriginAllowed(origin) {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  return allowedOrigins.includes(normalized);
}

import indexRoutes from "./src/routes/index.js";
import parseRoutes from "./src/routes/parse.js";
import checkhealth from "./src/routes/checkhealth.js";
import settingsRoutes from "./src/routes/settings.js";
import logsRoutes from "./src/routes/logs.js";
import emailRoutes from "./src/routes/email.js";
import uploadRoutes, { uploadErrorMiddleware } from "./src/routes/upload.js";

const app = express();
const httpServer = createServer(app);

// 🔥 Инициализация дефолтов
memoryStore.initDefaults({
  settingsForm: { duration: "1" },
});

console.log("⚙️ Настройки инициализированы:", memoryStore.getSettings());

// 🔥 Socket.IO с правильным CORS
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // 🔥 Разрешаем запросы без origin (curl, Postman, внутренние вызовы)
      if (!origin) return callback(null, true);

      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        console.warn(`❌ CORS blocked: ${origin}`);
        console.warn(`   Укажите в FRONT_ORIGIN или CORS_ORIGINS (через запятую), сейчас: ${allowedOrigins.join(", ")}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
});

// 🔥 Глобальный CORS middleware для REST API (дублируем для надёжности)
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!origin || isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  
  // Preflight для OPTIONS
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json({ limit: "50mb" })); // 🔥 Увеличиваем лимит для больших файлов

// 🔥 Socket.IO события
io.on("connection", (socket) => {
  console.log(`🔌 Подключён: ${socket.id}`);
  socket.emit("settings-sync", { settingsForm: memoryStore.getSettings() });
  socket.emit("connected", { message: "WebSocket ready", serverTime: new Date().toISOString() });
  socket.on("disconnect", (reason) => console.log(`🔌 Отключён: ${socket.id} | ${reason}`));
});

app.set("socketio", io);

// 🔥 Роуты
app.use("/", indexRoutes);
app.use("/", checkhealth);
app.use("/", uploadRoutes);
app.use("/", parseRoutes);
app.use("/", settingsRoutes);
app.use("/", logsRoutes);
app.use("/", emailRoutes);

// 🔥 Обработчик ошибок Multer (должен быть ПОСЛЕ роутов)
app.use(uploadErrorMiddleware);

// 🔥 Глобальный обработчик ошибок для ВСЕХ остальных случаев
app.use((err, req, res, next) => {
  console.error("💥 Global error:", err);
  
  // 🔥 ВСЕГДА возвращаем JSON, даже при ошибке
  if (!res.headersSent) {
    res.status(err.status || 500).json({
      error: err.message || "Внутренняя ошибка сервера",
      ...(process.env.NODE_ENV === "development" && { stack: err.stack })
    });
  }
});

// 🔥 Обработка 404
app.use((req, res) => {
  res.status(404).json({ error: "Маршрут не найден" });
});

const PORT = process.env.PORT || 4001;

httpServer.listen(PORT, "0.0.0.0", () => {
  // 🔥 Слушаем на всех интерфейсах
  console.log(`✅ service_auth on port ${PORT}`);
  const publicUrl = process.env.PUBLIC_URL || "";
  console.log(
    `🔌 Socket.IO: ${publicUrl ? `wss://${publicUrl.replace(/^https?:\/\//, "")}` : `ws://localhost:${PORT}`}`
  );
  console.log(`🌐 CORS allowed origins: ${allowedOrigins.join(", ")}`);
});

export { io };