import multer from "multer";

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB

  // 🔥 Фикс кодировки: перекодируем имя файла из latin1 в utf8
  fileFilter: (req, file, cb) => {
    // Исправляем кодировку имени файла, если она пришла в latin1
    if (file.originalname) {
      try {
        // 🔄 Конвертируем: latin1 → utf8
        file.originalname = Buffer.from(file.originalname, "latin1").toString(
          "utf8"
        );
      } catch (e) {
        // Если не получилось — оставляем как есть, чтобы не сломать загрузку
        console.warn(
          "⚠️ Не удалось перекодировать имя файла:",
          file.originalname
        );
      }
    }

    const allowedMimes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
    ];
    const name = (file.originalname || "").toLowerCase();
    const looksExcel =
      name.endsWith(".xlsx") ||
      name.endsWith(".xlsm") ||
      name.endsWith(".xls");

    // Браузеры/ОС часто шлют .xlsx как application/octet-stream
    const mimeOk =
      allowedMimes.includes(file.mimetype) ||
      (file.mimetype === "application/octet-stream" && looksExcel) ||
      ((!file.mimetype || file.mimetype === "") && looksExcel);

    if (mimeOk) {
      cb(null, true);
    } else {
      cb(new Error("Только .xlsx файлы разрешены"), false);
    }
  },
});

// Middleware для обработки ошибок Multer
export const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "Файл слишком большой (макс. 20MB)" });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
};
