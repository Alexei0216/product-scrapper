const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const config = require("./config");
const scrape = require("./scraper");
const settingsStore = require("./settings-store");

const API_BASE = `https://api.telegram.org/bot${config.telegram.token}`;
const runningChats = new Set();
const sessions = new Map();
const startedAt = new Date();
const runtimeStatus = {
  telegramReady: false,
  lastUpdateAt: null,
  lastPollError: null,
};
const MAX_ARCHIVE_URLS = 10;
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const fieldLabels = {
  category: "Категория",
  productBrand: "Бренд товара",
  carBrand: "Марка машины",
  carModel: "Модель машины",
  priceMarkup: "Наценка к цене",
};

const optionKeys = {
  category: "categories",
  productBrand: "productBrands",
  carBrand: "carBrands",
  carModel: "carModels",
};

const stockModes = {
  instock: "В наличии",
  backorder: "Предзаказ",
  outofstock: "Нет в наличии",
};

function isUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[),.;]+$/g, "")).filter(isUrl))];
}

function isAllowed(chatId) {
  return (
    config.telegram.allowedChatIds.length === 0 ||
    config.telegram.allowedChatIds.includes(String(chatId))
  );
}

function truncate(value, max = 36) {
  const text = String(value || "Не задано");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatValue(value, fallback = "Не задано") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "считаю";
  if (seconds < 60) return `${Math.ceil(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.ceil(seconds % 60);
  return rest ? `${minutes} мин ${rest} сек` : `${minutes} мин`;
}

function fieldOptions(field) {
  const settings = settingsStore.getSettings();
  if (field === "category") return settings.categories;
  if (field === "productBrand") return settings.productBrands;
  if (field === "carBrand") return settings.carBrands;
  if (field === "carModel") return settings.carModels;
  return [];
}

function createSession(archiveUrls) {
  const urls = Array.isArray(archiveUrls) ? archiveUrls : [archiveUrls].filter(Boolean);
  const settings = settingsStore.getSettings();
  return {
    archiveUrls: urls,
    archiveUrl: urls[0] || "",
    category: config.csvDefaults.category,
    productBrand: config.csvDefaults.productBrand,
    carBrand: config.csvDefaults.carBrand,
    carModel: config.csvDefaults.carModel,
    priceMarkup: config.csvDefaults.priceMarkup,
    stockMode: config.csvDefaults.stockMode || "backorder",
    maxArchivePages: config.scraper.maxArchivePages,
    maxProducts: config.scraper.maxProducts,
    productConcurrency: config.scraper.productConcurrency,
    awaitingField: "",
    awaitingNumberField: "",
    awaitingSettingsField: "",
    panelMessageId: null,
  };
}

async function telegram(method, body) {
  const attempts = method === "getUpdates" ? 1 : config.telegram.retryAttempts;
  const timeoutMs =
    method === "getUpdates"
      ? config.telegram.longPollTimeoutMs
      : config.telegram.requestTimeoutMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        const error = new Error(payload.description || `Telegram API error: ${response.status}`);
        error.status = response.status;
        error.retryAfter = payload.parameters?.retry_after;
        throw error;
      }

      return payload.result;
    } catch (error) {
      const retryable = isRetryableTelegramError(error);
      if (!retryable || attempt >= attempts) {
        throw new Error(describeTelegramError(method, error));
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, error)));
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRetryableTelegramError(error) {
  if (error.name === "AbortError") return true;
  if (error.status === 429 || error.status >= 500) return true;
  const codes = [error.code, error.cause?.code, ...(error.cause?.errors || []).map((item) => item.code)];
  return codes.some((code) => RETRYABLE_ERROR_CODES.has(code));
}

function retryDelayMs(attempt, error) {
  if (error.retryAfter) return Number(error.retryAfter) * 1000;
  return Math.min(1000 * attempt, 5000);
}

function describeTelegramError(method, error) {
  const cause = error.cause;
  const causeCode =
    error.code ||
    cause?.code ||
    cause?.errors?.map((item) => item.code).filter(Boolean).join(", ");
  const detail = causeCode ? `${error.message} (${causeCode})` : error.message;
  return `Telegram ${method} failed: ${detail}`;
}

async function validateTelegramToken() {
  if (!config.telegram.token) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан. Вставь токен из @BotFather в файл .env.");
  }

  const tokenShapeOk = /^\d+:[A-Za-z0-9_-]{20,}$/.test(config.telegram.token);
  if (!tokenShapeOk) {
    console.warn(
      "Warning: TELEGRAM_BOT_TOKEN выглядит необычно. Обычно токен имеет формат 123456789:AA..."
    );
  }

  try {
    const me = await telegram("getMe", {});
    console.log(`Telegram bot connected: @${me.username || me.first_name}`);
  } catch (error) {
    throw new Error(
      [
        "Telegram token не принят API.",
        "Проверь .env: TELEGRAM_BOT_TOKEN должен быть только токеном из @BotFather, без https://api.telegram.org/bot и без лишних символов.",
        `Ответ Telegram: ${error.message}`,
      ].join(" ")
    );
  }
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => {});
}

async function sendDocument(chatId, filePath, caption) {
  const form = new FormData();
  const buffer = fs.readFileSync(filePath);

  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([buffer]), path.basename(filePath));

  const response = await fetch(`${API_BASE}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description || `Telegram upload error: ${response.status}`);
  }
}

function runDirFor(chatId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(process.cwd(), "runs", `${chatId}-${stamp}`);
}

function progressBar(current, total, width = 14) {
  if (!total) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function progressText(state) {
  const total = state.total || 0;
  const current = state.current || 0;
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const elapsedSeconds = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const etaSeconds = current > 0 && total > current ? (elapsedSeconds / current) * (total - current) : 0;

  return [
    "Сбор товаров",
    "",
    `${progressBar(current, total)} ${percent}%`,
    "",
    `Архивы: ${state.archiveCurrent || 0}/${state.archiveTotal || 0}`,
    `Карточки: ${current}/${total || "?"}`,
    `Сохранено: ${state.saved || 0}`,
    `Пропущено: ${state.skipped || 0}`,
    `Ошибок: ${state.errors || 0}`,
    `Потоков: ${state.active || 0}/${state.concurrency || 1}`,
    total && current < total ? `Осталось: ${formatSeconds(etaSeconds)}` : "",
    state.status ? `Статус: ${state.status}` : "",
  ].filter(Boolean).join("\n");
}

function panelText(session) {
  return [
    "Импорт WooCommerce",
    "",
    "Источник",
    `Ссылок: ${session.archiveUrls.length}`,
    ...session.archiveUrls.slice(0, 3).map((url, index) => `${index + 1}. ${url}`),
    session.archiveUrls.length > 3 ? `Еще ссылок: ${session.archiveUrls.length - 3}` : "",
    "",
    "Таксономии",
    `Категория: ${formatValue(session.category)}`,
    `Бренд товара: ${formatValue(session.productBrand)}`,
    `Марка машины: ${formatValue(session.carBrand)}`,
    `Модель машины: ${formatValue(session.carModel)}`,
    "",
    "Сбор",
    `Наценка: ${Number(session.priceMarkup || 0).toFixed(2)}`,
    `Наличие: ${stockModes[session.stockMode] || stockModes.backorder}`,
    `Страниц архива: ${session.maxArchivePages}`,
    `Лимит товаров: ${session.maxProducts}`,
    `Параллельно: ${session.productConcurrency}`,
    "",
    "Любое поле можно оставить пустым. Проверь настройки и запускай сбор.",
  ].join("\n");
}

function panelKeyboard(session) {
  return {
    inline_keyboard: [
      [
        { text: `Категория: ${truncate(session.category, 24)}`, callback_data: "cfg:category" },
        { text: `Бренд: ${truncate(session.productBrand, 24)}`, callback_data: "cfg:productBrand" },
      ],
      [
        { text: `Марка: ${truncate(session.carBrand, 24)}`, callback_data: "cfg:carBrand" },
        { text: `Модель: ${truncate(session.carModel, 24)}`, callback_data: "cfg:carModel" },
      ],
      [
        { text: `Страниц: ${session.maxArchivePages}`, callback_data: "cfg:pages" },
        { text: `Лимит: ${session.maxProducts}`, callback_data: "cfg:limit" },
      ],
      [
        { text: `Потоки: ${session.productConcurrency}`, callback_data: "cfg:concurrency" },
        { text: `Наценка: ${Number(session.priceMarkup || 0).toFixed(2)}`, callback_data: "cfg:priceMarkup" },
      ],
      [{ text: `Наличие: ${stockModes[session.stockMode] || stockModes.backorder}`, callback_data: "cfg:stockMode" }],
      [{ text: "Без таксономий", callback_data: "clear:taxonomies" }],
      [{ text: "Начать сбор", callback_data: "run:start" }],
      [{ text: "Справочники", callback_data: "settings:home" }, { text: "Отмена", callback_data: "run:cancel" }],
    ],
  };
}

function optionsKeyboard(field, session) {
  const values = fieldOptions(field);
  const buttons = values.slice(0, 24).map((value, index) => ({
    text: `${session[field] === value ? "[x] " : ""}${truncate(value, 28)}`,
    callback_data: `set:${field}:${index}`,
  }));
  const rows = [];

  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }

  rows.push([{ text: "Не указывать", callback_data: `clear:${field}` }]);
  rows.push([
    { text: "Ввести вручную", callback_data: `custom:${field}` },
    { text: "Добавить", callback_data: `dictadd:${field}` },
  ]);
  rows.push([{ text: "Назад", callback_data: "nav:back" }]);

  return { inline_keyboard: rows };
}

function numericKeyboard(type, values, current) {
  const rows = [];
  for (let index = 0; index < values.length; index += 2) {
    rows.push(
      values.slice(index, index + 2).map((value) => ({
        text: `${current === value ? "[x] " : ""}${value}`,
        callback_data: `${type}:${value}`,
      }))
    );
  }
  rows.push([{ text: "Назад", callback_data: "nav:back" }]);
  return { inline_keyboard: rows };
}

function stockModeKeyboard(current) {
  return {
    inline_keyboard: [
      [
        { text: `${current === "instock" ? "[x] " : ""}В наличии`, callback_data: "stock:instock" },
        { text: `${current === "backorder" ? "[x] " : ""}Предзаказ`, callback_data: "stock:backorder" },
      ],
      [{ text: `${current === "outofstock" ? "[x] " : ""}Нет в наличии`, callback_data: "stock:outofstock" }],
      [{ text: "Назад", callback_data: "nav:back" }],
    ],
  };
}

function settingsText() {
  const settings = settingsStore.getSettings();
  return [
    "Справочники",
    "",
    `Категории: ${settings.categories.length}`,
    `Бренды товара: ${settings.productBrands.length}`,
    `Марки машины: ${settings.carBrands.length}`,
    `Модели машины: ${settings.carModels.length}`,
    "",
    "Добавляй сюда значения, которые уже существуют на сайте. Потом они появятся кнопками при импорте.",
  ].join("\n");
}

function settingsKeyboard(session) {
  const rows = [
    [
      { text: "Категории", callback_data: "settings:list:category" },
      { text: "Бренды товара", callback_data: "settings:list:productBrand" },
    ],
    [
      { text: "Марки машины", callback_data: "settings:list:carBrand" },
      { text: "Модели машины", callback_data: "settings:list:carModel" },
    ],
  ];

  rows.push(
    session?.archiveUrls?.length
      ? [{ text: "Назад к импорту", callback_data: "nav:back" }]
      : [{ text: "Закрыть", callback_data: "settings:close" }]
  );
  return { inline_keyboard: rows };
}

function settingsListText(field) {
  const values = fieldOptions(field);
  const items = values.length
    ? values.map((value, index) => `${index + 1}. ${value}`).join("\n")
    : "Пока пусто.";

  return `${fieldLabels[field]}\n\n${items}`;
}

function settingsListKeyboard(field) {
  const values = fieldOptions(field);
  const rows = values.slice(0, 24).map((value, index) => [
    { text: `Удалить: ${truncate(value, 42)}`, callback_data: `settings:remove:${field}:${index}` },
  ]);

  rows.push([{ text: "Добавить", callback_data: `settings:add:${field}` }]);
  rows.push([{ text: "Назад", callback_data: "settings:home" }]);

  return { inline_keyboard: rows };
}

async function showPanel(chatId, session) {
  const extra = { reply_markup: panelKeyboard(session) };

  if (session.panelMessageId) {
    await editMessage(chatId, session.panelMessageId, panelText(session), extra).catch(async () => {
      const message = await sendMessage(chatId, panelText(session), extra);
      session.panelMessageId = message.message_id;
    });
    return;
  }

  const message = await sendMessage(chatId, panelText(session), extra);
  session.panelMessageId = message.message_id;
}

async function beginSession(chatId, archiveUrls) {
  if (runningChats.has(chatId)) {
    await sendMessage(chatId, "Уже идет сбор. Дождись результата, потом отправь следующую ссылку.");
    return;
  }

  const session = createSession(archiveUrls);
  sessions.set(chatId, session);
  await showPanel(chatId, session);
}

async function runSession(chatId, session) {
  if (runningChats.has(chatId)) {
    await sendMessage(chatId, "Уже идет сбор. Дождись результата.");
    return;
  }

  runningChats.add(chatId);
  sessions.delete(chatId);
  let progressMessageId = null;
  let lastProgressAt = 0;
  const progressState = {
    current: 0,
    total: 0,
    archiveCurrent: 0,
    archiveTotal: session.archiveUrls.length,
    saved: 0,
    skipped: 0,
    errors: 0,
    active: 0,
    concurrency: session.productConcurrency,
    startedAt: Date.now(),
    status: "Подготовка",
  };

  const updateProgress = async (event, force = false) => {
    if (typeof event === "string") {
      progressState.status = event.replace(/^Открываю архив\s*/i, "Открываю архив ");
    } else if (event?.stage === "archive") {
      progressState.archiveCurrent = event.current;
      progressState.archiveTotal = event.total;
      progressState.status = "Ищу товары в архиве";
    } else if (event?.stage === "links") {
      progressState.total = event.found;
      progressState.status = `Найдено ссылок: ${event.found}`;
    } else if (event?.stage === "product_start") {
      progressState.total = event.total;
      progressState.active = event.active ?? progressState.active;
      progressState.status = "Загружаю карточки товаров";
    } else if (event?.stage === "product_done") {
      progressState.current = event.current;
      progressState.total = event.total;
      progressState.saved = event.saved ?? progressState.saved;
      progressState.skipped = event.skipped ?? progressState.skipped;
      progressState.errors = event.errors ?? progressState.errors;
      progressState.active = event.active ?? progressState.active;
      progressState.status = "Собираю данные";
    } else if (event?.stage === "skip") {
      progressState.current = Math.max(progressState.current, event.current || 0);
      progressState.total = event.total;
      progressState.saved = event.saved ?? progressState.saved;
      progressState.skipped = event.skipped ?? progressState.skipped;
      progressState.errors = event.errors ?? progressState.errors;
      progressState.status = `Пропуск: ${event.reason}`;
    } else if (event?.stage === "error") {
      progressState.current = Math.max(progressState.current, event.current || 0);
      progressState.total = event.total;
      progressState.saved = event.saved ?? progressState.saved;
      progressState.skipped = event.skipped ?? progressState.skipped;
      progressState.errors = event.errors ?? progressState.errors;
      progressState.status = `Ошибка: ${event.error}`;
    }

    const now = Date.now();
    if (!force && now - lastProgressAt < 2500) return;
    lastProgressAt = now;

    const text = progressText(progressState);
    if (!progressMessageId) {
      const message = await sendMessage(chatId, text).catch(() => null);
      progressMessageId = message?.message_id || null;
      return;
    }

    await editMessage(chatId, progressMessageId, text).catch(() => {});
  };

  try {
    await sendMessage(
      chatId,
      [
        "Начинаю сбор товаров.",
        `Ссылок: ${session.archiveUrls.length}`,
        `Категория: ${session.category || "Не задано"}`,
        `Бренд товара: ${session.productBrand || "Не задано"}`,
        `Марка машины: ${session.carBrand || "Не задано"}`,
        `Модель машины: ${session.carModel || "Не задано"}`,
        `Наценка: ${Number(session.priceMarkup || 0).toFixed(2)}`,
        `Наличие: ${stockModes[session.stockMode] || stockModes.backorder}`,
        `Страниц архива: ${session.maxArchivePages}`,
        `Лимит товаров: ${session.maxProducts}`,
        `Параллельно: ${session.productConcurrency}`,
      ].join("\n")
    );
    await updateProgress({ stage: "links", found: 0 }, true);

    const result = await scrape({
      archiveUrls: session.archiveUrls,
      outputDir: runDirFor(chatId),
      maxArchivePages: session.maxArchivePages,
      maxProducts: session.maxProducts,
      productConcurrency: session.productConcurrency,
      csvDefaults: {
        ...config.csvDefaults,
        category: session.category,
        productBrand: session.productBrand,
        carBrand: session.carBrand,
        carModel: session.carModel,
        priceMarkup: session.priceMarkup,
        stockMode: session.stockMode,
      },
      progress: updateProgress,
    });
    progressState.current = progressState.total || result.products.length;
    progressState.total = progressState.total || result.products.length;
    progressState.saved = result.products.length;
    progressState.active = 0;
    progressState.status = "CSV готов";
    await updateProgress(null, true);

    if (result.products.length === 0) {
      await sendMessage(
        chatId,
        "Не получилось собрать товары: сайт не дал цены/названия или ссылки на карточки не похожи на товарные. Попробуй увеличить лимит/страницы или пришли другой архив."
      );
      return;
    }

    await sendDocument(
      chatId,
      result.csvFile,
      `WooCommerce CSV готов. Товаров: ${result.products.length}`
    );
    await sendDocument(chatId, result.jsonFile, "JSON с сырыми данными.");
    await sendDocument(
      chatId,
      result.reportFile,
      `Отчёт проверки: предупреждения у ${result.report.summary.productsWithWarnings} из ${result.report.summary.products} товаров.`
    );
    const customCount = result.report.summary.productsWithCustomOptions;
    await sendMessage(
      chatId,
      [
        "Готово. CSV можно импортировать в WooCommerce: Products -> Import.",
        customCount
          ? `У ${customCount} товаров условные опции превращены в нативные WooCommerce-вариации с допустимыми сочетаниями.`
          : "Перед публикацией проверь scrape-report.json: в нём отмечены отсутствующие или сгенерированные данные.",
      ].join("\n")
    );
  } catch (error) {
    progressState.status = `Ошибка: ${error.message}`;
    await updateProgress(null, true);
    await sendMessage(chatId, `Ошибка: ${error.message}`);
  } finally {
    runningChats.delete(chatId);
  }
}

async function handleCustomValue(chatId, text, session) {
  const field = session.awaitingField;
  if (!field) return false;

  session[field] = text;
  session.awaitingField = "";
  await showPanel(chatId, session);
  return true;
}

async function handleNumberValue(chatId, text, session) {
  const field = session.awaitingNumberField;
  if (!field) return false;

  const value = Number(String(text).replace(",", ".").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(value)) {
    await sendMessage(chatId, "Нужно число, например 25 или 12.50");
    return true;
  }

  session[field] = value;
  session.awaitingNumberField = "";
  await showPanel(chatId, session);
  return true;
}

async function handleSettingsValue(chatId, text, session) {
  const field = session.awaitingSettingsField;
  if (!field) return false;

  settingsStore.addOption(optionKeys[field], text);
  session.awaitingSettingsField = "";

  if (!session.archiveUrls.length) {
    await sendMessage(chatId, `Добавлено: ${text}`, {
      reply_markup: settingsKeyboard(session),
    });
    return true;
  }

  session[field] = text;
  await showPanel(chatId, session);
  return true;
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();

  if (!chatId || !text) return;
  if (!isAllowed(chatId)) {
    await sendMessage(chatId, "Этот бот закрыт для вашего chat_id.");
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendMessage(
      chatId,
      [
        `Отправь одну или несколько ссылок на страницы архива/категории товаров. Максимум: ${MAX_ARCHIVE_URLS}.`,
        "Если ссылок несколько, отправь каждую с новой строки.",
        "После ссылки я покажу панель импорта: таксономии, наличие, лимиты и скорость сбора.",
        "",
        "/settings - управлять справочниками кнопок",
      ].join("\n")
    );
    return;
  }

  if (text === "/settings") {
    const session = sessions.get(chatId) || createSession([]);
    sessions.set(chatId, session);
    const message = await sendMessage(chatId, settingsText(), { reply_markup: settingsKeyboard(session) });
    session.panelMessageId = message.message_id;
    return;
  }

  if (text === "/cancel") {
    sessions.delete(chatId);
    await sendMessage(chatId, "Настройка отменена.");
    return;
  }

  const session = sessions.get(chatId);
  if (session?.awaitingSettingsField && !isUrl(text)) {
    await handleSettingsValue(chatId, text, session);
    return;
  }

  if (session?.awaitingNumberField && !isUrl(text)) {
    await handleNumberValue(chatId, text, session);
    return;
  }

  if (session?.awaitingField && !isUrl(text)) {
    await handleCustomValue(chatId, text, session);
    return;
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    await sendMessage(
      chatId,
      "Нужна ссылка вида https://site.com/category/products. Можно отправить до 10 ссылок одним сообщением, каждую с новой строки."
    );
    return;
  }

  if (urls.length > MAX_ARCHIVE_URLS) {
    await sendMessage(chatId, `Слишком много ссылок: ${urls.length}. Пока можно максимум ${MAX_ARCHIVE_URLS}.`);
    return;
  }

  await beginSession(chatId, urls);
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data || "";

  if (!chatId || !messageId) return;
  if (!isAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, "Нет доступа.");
    return;
  }

  const session = sessions.get(chatId);
  if (!session && data !== "run:cancel") {
    await answerCallbackQuery(callbackQuery.id, "Сессия устарела. Отправь ссылку заново.");
    return;
  }

  await answerCallbackQuery(callbackQuery.id);

  if (data === "run:cancel") {
    sessions.delete(chatId);
    await editMessage(chatId, messageId, "Настройка отменена. Отправь новую ссылку, когда будешь готов.").catch(() => {});
    return;
  }

  if (data === "nav:back") {
    session.awaitingField = "";
    session.awaitingNumberField = "";
    session.awaitingSettingsField = "";
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data === "settings:home") {
    session.awaitingSettingsField = "";
    session.panelMessageId = messageId;
    await editMessage(chatId, messageId, settingsText(), { reply_markup: settingsKeyboard(session) });
    return;
  }

  if (data === "settings:close") {
    sessions.delete(chatId);
    await editMessage(chatId, messageId, "Справочники закрыты. Отправь ссылку для нового импорта.").catch(() => {});
    return;
  }

  if (data.startsWith("settings:list:")) {
    const field = data.split(":")[2];
    session.panelMessageId = messageId;
    await editMessage(chatId, messageId, settingsListText(field), {
      reply_markup: settingsListKeyboard(field),
    });
    return;
  }

  if (data.startsWith("settings:add:")) {
    const field = data.split(":")[2];
    session.awaitingSettingsField = field;
    session.panelMessageId = messageId;
    await editMessage(
      chatId,
      messageId,
      `Напиши новое значение для "${fieldLabels[field]}". Оно сохранится в справочник и появится кнопкой.\n\n/cancel отменит настройку.`
    );
    return;
  }

  if (data.startsWith("settings:remove:")) {
    const [, , field, indexRaw] = data.split(":");
    settingsStore.removeOption(optionKeys[field], Number(indexRaw));
    session.panelMessageId = messageId;
    await editMessage(chatId, messageId, settingsListText(field), {
      reply_markup: settingsListKeyboard(field),
    });
    return;
  }

  if (data.startsWith("cfg:")) {
    const field = data.split(":")[1];
    session.panelMessageId = messageId;

    if (field === "pages") {
      await editMessage(chatId, messageId, "Сколько страниц архива сканировать?", {
        reply_markup: numericKeyboard("pages", config.options.archivePages, session.maxArchivePages),
      });
      return;
    }

    if (field === "limit") {
      await editMessage(chatId, messageId, "Максимум товаров для этой выгрузки:", {
        reply_markup: numericKeyboard("limit", config.options.productLimits, session.maxProducts),
      });
      return;
    }

    if (field === "concurrency") {
      await editMessage(chatId, messageId, "Сколько карточек товаров собирать одновременно?", {
        reply_markup: numericKeyboard(
          "concurrency",
          config.options.productConcurrency,
          session.productConcurrency
        ),
      });
      return;
    }

    if (field === "priceMarkup") {
      session.awaitingNumberField = "priceMarkup";
      await editMessage(
        chatId,
        messageId,
        "Напиши сумму, которую нужно прибавить к каждой цене.\n\nПримеры: 25, 12.50, 0\n/cancel отменит настройку."
      );
      return;
    }

    if (field === "stockMode") {
      await editMessage(chatId, messageId, "Выбери статус наличия для WooCommerce:", {
        reply_markup: stockModeKeyboard(session.stockMode),
      });
      return;
    }

    await editMessage(chatId, messageId, `Выбери: ${fieldLabels[field]}`, {
      reply_markup: optionsKeyboard(field, session),
    });
    return;
  }

  if (data.startsWith("set:")) {
    const [, field, indexRaw] = data.split(":");
    const option = fieldOptions(field)[Number(indexRaw)];
    if (option !== undefined) session[field] = option;
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data.startsWith("clear:")) {
    const field = data.split(":")[1];

    if (field === "taxonomies") {
      session.category = "";
      session.productBrand = "";
      session.carBrand = "";
      session.carModel = "";
    } else if (Object.prototype.hasOwnProperty.call(optionKeys, field)) {
      session[field] = "";
    }

    session.awaitingField = "";
    session.awaitingSettingsField = "";
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data.startsWith("custom:")) {
    const field = data.split(":")[1];
    session.awaitingField = field;
    session.panelMessageId = messageId;
    await editMessage(
      chatId,
      messageId,
      `Напиши текст для поля "${fieldLabels[field]}". Он попадет в CSV как есть.\n\n/cancel отменит настройку.`
    );
    return;
  }

  if (data.startsWith("dictadd:")) {
    const field = data.split(":")[1];
    session.awaitingSettingsField = field;
    session.panelMessageId = messageId;
    await editMessage(
      chatId,
      messageId,
      `Напиши новое значение для "${fieldLabels[field]}". Я сохраню его в справочник и выберу для этого импорта.\n\n/cancel отменит настройку.`
    );
    return;
  }

  if (data.startsWith("pages:")) {
    session.maxArchivePages = Number(data.split(":")[1]) || session.maxArchivePages;
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data.startsWith("limit:")) {
    session.maxProducts = Number(data.split(":")[1]) || session.maxProducts;
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data.startsWith("concurrency:")) {
    session.productConcurrency = Number(data.split(":")[1]) || session.productConcurrency;
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data.startsWith("stock:")) {
    session.stockMode = data.split(":")[1] || session.stockMode;
    session.panelMessageId = messageId;
    await showPanel(chatId, session);
    return;
  }

  if (data === "run:start") {
    await editMessage(chatId, messageId, "Настройки приняты. Запускаю сбор...").catch(() => {});
    await runSession(chatId, session);
  }
}

async function poll() {
  await validateTelegramToken();
  runtimeStatus.telegramReady = true;
  runtimeStatus.lastPollError = null;

  let offset = 0;
  if (config.telegram.allowedChatIds[0]) {
    await sendMessage(config.telegram.allowedChatIds[0], "Бот запущен.").catch(() => {});
  }

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        runtimeStatus.lastUpdateAt = new Date();
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message).catch((error) => {
            console.error("Message handling error:", error.message || error);
          });
        }
        if (update.callback_query) {
          handleCallbackQuery(update.callback_query).catch((error) => {
            console.error("Callback handling error:", error.message || error);
          });
        }
      }
    } catch (error) {
      runtimeStatus.lastPollError = error.message || String(error);
      console.error("Polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function startHealthServer() {
  const port = Number(process.env.PORT || process.env.BOT_HEALTH_PORT || 3000);
  const keepAliveUrl = process.env.BOT_KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || "";
  const keepAliveIntervalMs = Number(process.env.BOT_KEEP_ALIVE_INTERVAL_MS || 10 * 60 * 1000);

  const server = http.createServer((req, res) => {
    const body = {
      ok: runtimeStatus.telegramReady,
      service: "product-scrapper-bot",
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: startedAt.toISOString(),
      lastUpdateAt: runtimeStatus.lastUpdateAt
        ? runtimeStatus.lastUpdateAt.toISOString()
        : null,
      lastPollError: runtimeStatus.lastPollError,
      runningJobs: runningChats.size,
    };

    if (req.url === "/" || req.url === "/healthz") {
      res.writeHead(runtimeStatus.telegramReady ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(`${JSON.stringify(body)}\n`);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });

  if (keepAliveUrl && Number.isFinite(keepAliveIntervalMs) && keepAliveIntervalMs > 0) {
    setInterval(() => {
      pingUrl(keepAliveUrl);
    }, keepAliveIntervalMs).unref();
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function pingUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    console.error("Keep-alive ping error: invalid BOT_KEEP_ALIVE_URL");
    return;
  }

  const client = url.protocol === "https:" ? https : http;
  const req = client.request(
    url,
    { method: "GET", timeout: 15000 },
    (res) => {
      res.resume();
    }
  );

  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (error) => {
    console.error("Keep-alive ping error:", error.message || error);
  });
  req.end();
}

startHealthServer();

poll().catch((error) => {
  console.error(error);
  process.exit(1);
});
