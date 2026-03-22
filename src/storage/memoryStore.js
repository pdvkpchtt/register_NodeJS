const MAX_LOGS = 50; // 🔥 Храним только последние 50 логов

const store = {
  file: null,
  settingsForm: { duration: "1" },
  processing: {
    isActive: false,
    startedAt: null,
    stats: { total: 0, success: 0, failed: 0, processed: 0 },
    lastLog: null,
  },
  // 🔥 Массив логов (циклический буфер)
  logs: [],
};

export const memoryStore = {
  // ... существующие методы для file, settings, processing ...

  setFile: (fileData) => {
    store.file = fileData;
  },
  getFile: () => store.file,
  clearFile: () => {
    store.file = null;
  },
  hasFile: () => store.file !== null,

  setSettings: (newSettings) => {
    store.settingsForm = { ...store.settingsForm, ...newSettings };
  },
  getSettings: () => store.settingsForm,
  getSetting: (key) => store.settingsForm[key],

  setProcessing: (data) => {
    store.processing = { ...store.processing, ...data };
  },
  getProcessing: () => store.processing,
  isProcessing: () => store.processing.isActive,
  stopProcessing: () => {
    store.processing.isActive = false;
    store.processing.stoppedAt = new Date().toISOString();
  },

  // 🔥 НОВЫЕ МЕТОДЫ ДЛЯ ЛОГОВ

  addLog: (logEntry) => {
    // Добавляем лог в начало массива (новые сверху)
    store.logs.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...logEntry,
    });

    // 🔥 Обрезаем до MAX_LOGS, если превысили лимит
    if (store.logs.length > MAX_LOGS) {
      store.logs = store.logs.slice(0, MAX_LOGS);
    }
  },

  getLogs: (limit = MAX_LOGS) => {
    // Возвращаем логи в обратном порядке (старые → новые) для отображения
    return [...store.logs].reverse().slice(0, limit);
  },

  clearLogs: () => {
    store.logs = [];
  },

  // Универсальные методы
  set: (key, value) => {
    store[key] = value;
  },
  get: (key) => store[key],
  has: (key) => store[key] !== undefined && store[key] !== null,
  clear: (key) => {
    if (key) store[key] = null;
  },

  initDefaults: (defaults = {}) => {
    if (defaults.settingsForm) {
      store.settingsForm = { ...store.settingsForm, ...defaults.settingsForm };
    }
  },

  getAll: () => ({ ...store }),
};
