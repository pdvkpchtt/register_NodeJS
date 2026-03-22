import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

import { memoryStore } from "./src/storage/memoryStore.js"; // 🔥 Импорт хранилища

import indexRoutes from "./src/routes/index.js";
import parseRoutes from "./src/routes/parse.js";
import checkhealth from "./src/routes/checkhealth.js";
import settingsRoutes from "./src/routes/settings.js";
import logsRoutes from "./src/routes/logs.js";
import emailRoutes from "./src/routes/email.js";
import uploadRoutes, { uploadErrorMiddleware } from "./src/routes/upload.js";

const app = express();
const httpServer = createServer(app);

// 🔥 Инициализация дефолтных настроек ПЕРЕД запуском сервера
memoryStore.initDefaults({
  settingsForm: {
    duration: "1", // Значение по умолчанию
    // 🔥 Здесь можно добавить другие поля в будущем:
    // maxRetries: 3,
    // timeout: 30000,
  },
});

console.log("⚙️ Настройки инициализированы:", memoryStore.getSettings());

const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:5173", process.env.FRONT_ORIGIN].filter(Boolean),
    credentials: true,
  },
});

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      "http://localhost:5173",
      process.env.FRONT_ORIGIN,
    ].filter(Boolean);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.use(express.json());

io.on("connection", (socket) => {
  console.log(`🔌 Клиент подключён: ${socket.id}`);

  // 🔥 Отправляем текущие настройки при подключении (опционально)
  socket.emit("settings-sync", {
    settingsForm: memoryStore.getSettings(),
  });

  socket.emit("connected", {
    message: "WebSocket connected",
    serverTime: new Date().toISOString(),
  });

  socket.on("disconnect", (reason) => {
    console.log(`🔌 Клиент отключён: ${socket.id} | Причина: ${reason}`);
  });
});

app.set("socketio", io);

app.use("/", indexRoutes);
app.use("/", checkhealth);
app.use("/", uploadRoutes);
app.use("/", parseRoutes);
app.use("/", settingsRoutes);
app.use("/", logsRoutes);
app.use("/", emailRoutes);

app.use(uploadErrorMiddleware);

const PORT = process.env.PORT || 4001;

httpServer.listen(PORT, () => {
  console.log(`✅ service_auth running on port ${PORT}`);
  console.log(`🔌 Socket.IO ready: ws://localhost:${PORT}`);
  console.log(`⚙️ Default settings:`, memoryStore.getSettings());
});

export { io };
