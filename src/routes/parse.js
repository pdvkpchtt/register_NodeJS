import { Router } from "express";
import XLSX from "xlsx";
import { memoryStore } from "../storage/memoryStore.js";
import { processRow } from "../services/rowProcessor.js";

const router = Router();

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

// 🔥 GET /parse-stream — ГЛАВНЫЙ РОУТ
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

    const file = memoryStore.getFile();
    const batchSize = 1;
    const durationMinutes = parseInt(memoryStore.getSetting("duration")) || 0;
    const cooldownMs = durationMinutes > 0 ? durationMinutes * 60 * 1000 : 0;

    let isCancelled = false;
    req.on("close", () => {
      isCancelled = true;
    });

    // 🔥 Читаем файл для записи
    const workbookWrite = XLSX.read(file.buffer, {
      type: "buffer",
      cellText: true,
    });
    const sheetName = workbookWrite.SheetNames[0];
    const worksheetWrite = workbookWrite.Sheets[sheetName];
    const fullRange = XLSX.utils.decode_range(worksheetWrite["!ref"]);
    const endRow = fullRange.e.r;

    // 🔥 Заголовки
    const headerRow = XLSX.utils.sheet_to_json(worksheetWrite, {
      range: { s: { r: 0, c: fullRange.s.c }, e: { r: 0, c: fullRange.e.c } },
      header: 1,
      defval: "",
    })[0];
    const headers = headerRow.map((h, i) =>
      h ? String(h).trim() : `column_${i}`
    );

    // 🔥 Поиск колонок
    const completedColIndex = headers.findIndex(
      (h) => h?.trim().toLowerCase() === "завершен"
    );
    const emailColIndex = headers.findIndex(
      (h) =>
        h?.trim().toLowerCase() === "почта" ||
        h?.trim().toLowerCase() === "email"
    );
    const emailIdColIndex = headers.findIndex(
      (h) =>
        h?.trim().toLowerCase() === "индекс почты" ||
        h?.trim().toLowerCase() === "emailid" ||
        h?.trim().toLowerCase() === "id почты"
    ); // 🔥 Новая колонка

    console.log(`📊 Файл: ${file.originalname}, строк: ${endRow}`);
    console.log(
      `✅ "Завершен": ${
        completedColIndex !== -1 ? `#${completedColIndex + 1}` : "не найдена"
      }`
    );
    console.log(
      `✅ "Почта": ${
        emailColIndex !== -1 ? `#${emailColIndex + 1}` : "не найдена"
      }`
    );

    // 🔥 Хелперы
    const emitLog = (level, message, meta = {}) => {
      const io = req.app.get("socketio");
      const logData = {
        level,
        message,
        ...meta,
        timestamp: new Date().toISOString(),
      };
      if (io && io.sockets?.sockets?.size > 0) io.emit("process-log", logData);
      memoryStore.addLog(logData);
      console.log(`[${level}] ${message}`, meta);
    };

    const emitProgress = (processed, total, success, failed) => {
      const io = req.app.get("socketio");
      const data = {
        percent: total > 0 ? Math.round((processed / total) * 100) : 0,
        processed,
        total,
        success,
        failed,
        timestamp: new Date().toISOString(),
      };
      if (io && io.sockets?.sockets?.size > 0)
        io.emit("process-progress", data);
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
    const results = { success: 0, failed: 0, rows: [] };

    emitLog("info", `🚀 Старт: ${file.originalname}`, {
      cooldown: cooldownMs ? `${durationMinutes} мин` : "нет",
    });

    const io = req.app.get("socketio");
    if (io)
      io.emit("process-started", {
        filename: file.originalname,
        totalRows: endRow,
        timestamp: new Date().toISOString(),
      });

    // 🔄 Цикл по строкам
    for (let start = startRow; start <= endRow; start += batchSize) {
      if (isCancelled || !memoryStore.isProcessing()) {
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

      let wasProcessed = false;

      for (const row of chunkData) {
        if (isCancelled || !memoryStore.isProcessing()) break;

        const userName =
          row["ФАМИЛИЯ"] || row["Фамилия"] || `Row #${start + 1}`;
        const excelRowIndex = start;

        // ✅ ПРОВЕРКА 1: Уже завершена? → пропускаем
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
            continue;
          }
        }

        // 📧 ПРОВЕРКА 2: Есть ли почта?
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

        // 🔥 Вызов processRow
        const result = await processRow(
          row,
          { externalEmail: shouldGenerateEmail ? null : emailAddress },
          emitLog
        );

        // ✏️ ОБНОВЛЕНИЕ ФАЙЛА
        let fileChanged = false;

        // 1. Записываем почту, если сгенерировали новую
        if (shouldGenerateEmail && result.email && emailColIndex !== -1) {
          const emailCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: emailColIndex,
          });
          worksheetWrite[emailCellRef] = { t: "s", v: result.email };
          emitLog("debug", `✏️ Записана почта: ${result.email}`);
          fileChanged = true;
        }

        // 🔥 2. Записываем emailId в колонку "Индекс почты"
        if (shouldGenerateEmail && result.emailId && emailIdColIndex !== -1) {
          const emailIdCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: emailIdColIndex,
          });
          worksheetWrite[emailIdCellRef] = { t: "s", v: result.emailId };
          emitLog("debug", `✏️ Записан индекс почты: ${result.emailId}`);
          fileChanged = true;
        }

        // 3. Записываем "да" при успехе
        if (result.success && completedColIndex !== -1) {
          const completedCellRef = XLSX.utils.encode_cell({
            r: excelRowIndex,
            c: completedColIndex,
          });
          worksheetWrite[completedCellRef] = { t: "s", v: "да" };
          emitLog("debug", `✏️ "Завершен" → "да"`);
          fileChanged = true;
        }

        // 3. Сохраняем в память
        if (fileChanged) updateFileInMemory();

        await new Promise((r) => setTimeout(r, 100));

        results.rows.push(result);
        if (result.success) results.success++;
        else results.failed++;
        wasProcessed = true;
      }

      chunkData.length = 0;
      if (start % 5 === 0)
        await new Promise((resolve) => setImmediate(resolve));

      const processed = start - startRow + 1;
      const total = endRow - startRow + 1;
      emitProgress(processed, total, results.success, results.failed);

      // 😴 Кулдаун
      if (cooldownMs > 0 && wasProcessed && start <= endRow) {
        emitLog("info", `😴 Пауза ${durationMinutes} мин...`);
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, cooldownMs);
          const checkCancel = setInterval(() => {
            if (isCancelled || !memoryStore.isProcessing()) {
              clearTimeout(timeout);
              clearInterval(checkCancel);
              resolve();
            }
          }, 1000);
        });
        if (isCancelled) break;
      }
    }

    // 💾 Финальное сохранение
    updateFileInMemory();
    emitLog("success", `💾 Файл сохранён`);

    const finalMessage = `✅ Готово! Успешно: ${results.success}, Ошибок: ${results.failed}`;
    emitLog("success", finalMessage);
    memoryStore.stopProcessing();

    if (io)
      io.emit("process-stopped", {
        reason: "completed",
        stats: {
          total: results.rows.length,
          success: results.success,
          failed: results.failed,
        },
        timestamp: new Date().toISOString(),
      });

    res.json({
      success: true,
      message: "Обработка завершена",
      stats: {
        total: results.rows.length,
        success: results.success,
        failed: results.failed,
      },
    });
  } catch (err) {
    console.error("❌ Ошибка:", err);
    memoryStore.stopProcessing();
    const io = req.app.get("socketio");
    if (io?.sockets?.sockets?.size > 0) {
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
