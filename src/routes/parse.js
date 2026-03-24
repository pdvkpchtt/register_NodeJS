import { Router } from "express";
import XLSX from "xlsx";
import { memoryStore } from "../storage/memoryStore.js";
import { processRow } from "../services/rowProcessor.js";

const router = Router();

// 🔥 Генерация случайного целого числа в диапазоне [min, max]
const randomInRange = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

// 🔥 Форматирование времени: 157000ms → "2 мин 37 сек"
const formatDuration = (ms) => {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} сек`);
  return parts.join(" ");
};

// 🔥 GET /parse-stream/status
router.get("/parse-stream/status", (req, res) => {
  const processing = memoryStore.getProcessing();
  const logs = memoryStore.getLogs(50);
  res.json({
    success: true,
    isProcessing: processing.isActive,
    stats: processing.stats,
    startedAt: processing.startedAt,
    logs,
  });
});

// 🔥 POST /parse-stream/stop
router.post("/parse-stream/stop", (req, res) => {
  if (!memoryStore.isProcessing()) {
    return res.status(400).json({ error: "Нет активного процесса" });
  }
  memoryStore.stopProcessing();
  const io = req.app.get("socketio");
  if (io) {
    io.emit("process-stopped", {
      reason: "user_cancelled",
      stats: memoryStore.getProcessing().stats,
      timestamp: new Date().toISOString(),
    });
  }
  console.log("🛑 Процесс остановлен пользователем");
  res.json({
    success: true,
    message: "Процесс остановлен",
    stats: memoryStore.getProcessing().stats,
  });
});

/**
 * Фоновая обработка: не привязана к HTTP-запросу.
 * Останавливается только через POST /parse-stream/stop.
 */
async function runParseJob(app) {
  const getIo = () => app.get("socketio");

  try {
    const file = memoryStore.getFile();
    const batchSize = 1;

    // 🔥 Читаем настройки duration и durationMax (в минутах)
    const durationMin = parseInt(memoryStore.getSetting("duration")) || 0;
    const durationMax =
      parseInt(memoryStore.getSetting("durationMax")) || durationMin;

    // 🔥 Нормализуем: min <= max
    const minMinutes = Math.min(durationMin, durationMax);
    const maxMinutes = Math.max(durationMin, durationMax);

    // 🔥 Генерация случайной паузы в миллисекундах (с точностью до секунды)
    // Вызываем эту функцию КАЖДЫЙ РАЗ перед паузой для новой строки
    const getRandomCooldownMs = () => {
      if (maxMinutes === 0) return 0;
      const minSeconds = minMinutes * 60;
      const maxSeconds = maxMinutes * 60;
      const randomSeconds = randomInRange(minSeconds, maxSeconds);
      return randomSeconds * 1000;
    };

    const workbookWrite = XLSX.read(file.buffer, {
      type: "buffer",
      cellText: true,
    });
    const sheetName = workbookWrite.SheetNames[0];
    const worksheetWrite = workbookWrite.Sheets[sheetName];
    const fullRange = XLSX.utils.decode_range(worksheetWrite["!ref"]);
    const endRow = fullRange.e.r;

    const headerRow = XLSX.utils.sheet_to_json(worksheetWrite, {
      range: { s: { r: 0, c: fullRange.s.c }, e: { r: 0, c: fullRange.e.c } },
      header: 1,
      defval: "",
    })[0];
    const headers = headerRow.map((h, i) =>
      h ? String(h).trim() : `column_${i}`,
    );

    const completedColIndex = headers.findIndex(
      (h) => h?.trim().toLowerCase() === "завершен",
    );
    const emailColIndex = headers.findIndex(
      (h) =>
        h?.trim().toLowerCase() === "почта" ||
        h?.trim().toLowerCase() === "email",
    );
    const emailIdColIndex = headers.findIndex(
      (h) =>
        h?.trim().toLowerCase() === "индекс почты" ||
        h?.trim().toLowerCase() === "emailid" ||
        h?.trim().toLowerCase() === "id почты",
    );

    console.log(`📊 Файл: ${file.originalname}, строк: ${endRow}`);
    console.log(
      `✅ "Завершен": ${
        completedColIndex !== -1 ? `#${completedColIndex + 1}` : "не найдена"
      }`,
    );
    console.log(
      `✅ "Почта": ${
        emailColIndex !== -1 ? `#${emailColIndex + 1}` : "не найдена"
      }`,
    );

    const emitLog = (level, message, meta = {}) => {
      const io = getIo();
      const logData = {
        level,
        message,
        ...meta,
        timestamp: new Date().toISOString(),
      };
      if (io) io.emit("process-log", logData);
      memoryStore.addLog(logData);
      console.log(`[${level}] ${message}`, meta);
    };

    const emitProgress = (processed, total, success, failed) => {
      const io = getIo();
      const data = {
        percent: total > 0 ? Math.round((processed / total) * 100) : 0,
        processed,
        total,
        success,
        failed,
        timestamp: new Date().toISOString(),
      };
      if (io) io.emit("process-progress", data);
      memoryStore.setProcessing({
        stats: { ...memoryStore.getProcessing().stats, ...data },
      });
    };

    const updateFileInMemory = () => {
      try {
        const buffer = XLSX.write(workbookWrite, {
          type: "buffer",
          bookType: "xlsx",
          bookSST: false,
        });
        memoryStore.setFile({
          ...file,
          buffer,
          updatedAt: new Date().toISOString(),
        });
        return true;
      } catch (e) {
        console.error("❌ Ошибка сохранения:", e.message);
        return false;
      }
    };

    const startRow = 1;
    const totalRows = endRow - startRow + 1;
    const results = { success: 0, failed: 0, rows: [] };

    memoryStore.setProcessing({
      stats: {
        ...memoryStore.getProcessing().stats,
        total: totalRows,
        processed: 0,
        success: 0,
        failed: 0,
        percent: 0,
      },
    });

    emitLog("info", `🚀 Старт: ${file.originalname}`, {
      cooldown: maxMinutes > 0 ? `${minMinutes}-${maxMinutes} мин` : "нет",
    });

    const io = getIo();
    if (io) {
      io.emit("process-started", {
        filename: file.originalname,
        totalRows: endRow,
        timestamp: new Date().toISOString(),
      });
    }

    emitProgress(0, totalRows, 0, 0);

    parseRows: for (let start = startRow; start <= endRow; start += batchSize) {
      if (!memoryStore.isProcessing()) {
        emitLog("warn", "⚠️ Прервано");
        break;
      }

      const chunkRange = {
        s: { r: start, c: fullRange.s.c },
        e: { r: Math.min(start + batchSize - 1, endRow), c: fullRange.e.c },
      };
      const chunkData = XLSX.utils.sheet_to_json(worksheetWrite, {
        range: chunkRange,
        header: headers,
        defval: "",
      });

      for (const row of chunkData) {
        if (!memoryStore.isProcessing()) break;

        const userName =
          row["ФАМИЛИЯ"] || row["Фамилия"] || `Row #${start + 1}`;
        const excelRowIndex = start;

        // Проверка на "Завершен"
        if (completedColIndex !== -1) {
          const cellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: completedColIndex,
          });
          const completedValue = worksheetWrite[cellRef]?.v;
          if (
            completedValue &&
            String(completedValue).trim().toLowerCase() === "да"
          ) {
            emitLog("info", `⏭️ Пропуск: ${userName} (уже "да")`, {
              row: start + 1,
            });
            results.rows.push({ success: true, row, skipped: true });
            results.success++;

            // 🔥 Пауза даже после пропуска (если нужно)
            if (maxMinutes > 0) {
              const cooldownMs = getRandomCooldownMs();
              await new Promise((resolve) => setTimeout(resolve, cooldownMs));
            }
            continue;
          }
        }

        let emailAddress = null;
        let shouldGenerateEmail = true;

        if (emailColIndex !== -1) {
          const emailCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: emailColIndex,
          });
          const existingEmail = worksheetWrite[emailCellRef]?.v;
          if (existingEmail && String(existingEmail).includes("@")) {
            emailAddress = String(existingEmail).trim();
            shouldGenerateEmail = false;
            emitLog("info", `📧 Используем почту из файла: ${emailAddress}`, {
              row: start + 1,
            });
          }
        }

        emitLog("info", `🔄 Обработка: ${userName}`, {
          row: start + 1,
          email: emailAddress || "новая",
        });

        const result = await processRow(
          row,
          {
            externalEmail: shouldGenerateEmail ? null : emailAddress,
            shouldContinue: () => memoryStore.isProcessing(),
          },
          emitLog,
        );

        if (result.cancelled) {
          emitLog("warn", "⚠️ Остановка: прервана текущая строка");
          break parseRows;
        }

        let fileChanged = false;

        if (shouldGenerateEmail && result.email && emailColIndex !== -1) {
          const emailCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: emailColIndex,
          });
          worksheetWrite[emailCellRef] = { t: "s", v: result.email };
          emitLog("debug", `✏️ Записана почта: ${result.email}`);
          fileChanged = true;
        }

        if (shouldGenerateEmail && result.emailId && emailIdColIndex !== -1) {
          const emailIdCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: emailIdColIndex,
          });
          worksheetWrite[emailIdCellRef] = { t: "s", v: result.emailId };
          emitLog("debug", `✏️ Записан индекс почты: ${result.emailId}`);
          fileChanged = true;
        }

        if (result.success && completedColIndex !== -1) {
          const completedCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: completedColIndex,
          });
          worksheetWrite[completedCellRef] = { t: "s", v: "да" };
          emitLog("debug", `✏️ "Завершен" → "да"`);
          fileChanged = true;
        }

        if (fileChanged) updateFileInMemory();

        await new Promise((r) => setTimeout(r, 100));

        results.rows.push(result);
        if (result.success) results.success++;
        else results.failed++;

        // 🔥 Обновляем прогресс после каждой строки
        const processed = start - startRow + 1;
        emitProgress(processed, totalRows, results.success, results.failed);

        // 🔥 🔥 🔥 ПАУЗА ПОСЛЕ КАЖДОЙ СТРОКИ С НОВЫМ РАНДОМОМ 🔥 🔥 🔥
        if (maxMinutes > 0) {
          const cooldownMs = getRandomCooldownMs(); // <-- Новый рандом каждый раз!
          const formattedPause = formatDuration(cooldownMs);

          emitLog("info", `😴 Пауза ${formattedPause}...`);

          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, cooldownMs);
            const checkCancel = setInterval(() => {
              if (!memoryStore.isProcessing()) {
                clearTimeout(timeout);
                clearInterval(checkCancel);
                resolve();
              }
            }, 1000);
          });

          if (!memoryStore.isProcessing()) break parseRows;
        }
      }

      chunkData.length = 0;
      if (start % 5 === 0)
        await new Promise((resolve) => setImmediate(resolve));
    }

    updateFileInMemory();
    emitLog("success", `💾 Файл сохранён`);

    if (!memoryStore.isProcessing()) {
      return;
    }

    const finalMessage = `✅ Готово! Успешно: ${results.success}, Ошибок: ${results.failed}`;
    emitLog("success", finalMessage);
    memoryStore.stopProcessing();

    const ioFinal = getIo();
    if (ioFinal) {
      ioFinal.emit("process-stopped", {
        reason: "completed",
        stats: {
          total: results.rows.length,
          success: results.success,
          failed: results.failed,
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("❌ Ошибка:", err);
    memoryStore.stopProcessing();
    const io = getIo();
    if (io) {
      io.emit("process-stopped", {
        reason: "error",
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      io.emit("process-log", {
        level: "error",
        message: `❌ ${err.message}`,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// 🔥 GET /parse-stream — запуск фоновой обработки
router.get("/parse-stream", async (req, res) => {
  try {
    if (memoryStore.isProcessing()) {
      return res.status(409).json({
        error: "Процесс уже запущен",
        stats: memoryStore.getProcessing().stats,
      });
    }
    if (!memoryStore.hasFile()) {
      return res.status(404).json({ error: "Файл не найден" });
    }

    memoryStore.setProcessing({
      isActive: true,
      startedAt: new Date().toISOString(),
      stats: { total: 0, success: 0, failed: 0, processed: 0 },
    });

    const app = req.app;
    setImmediate(() => {
      runParseJob(app).catch((err) => {
        console.error("❌ runParseJob:", err);
        memoryStore.stopProcessing();
        const io = app.get("socketio");
        if (io) {
          io.emit("process-stopped", {
            reason: "error",
            error: err.message,
            timestamp: new Date().toISOString(),
          });
        }
      });
    });

    return res.status(202).json({
      success: true,
      message: "Обработка запущена",
    });
  } catch (err) {
    console.error("❌ Ошибка:", err);
    memoryStore.stopProcessing();
    return res.status(500).json({ error: err.message });
  }
});

export default router;
