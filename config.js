const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const file = path.join(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name] || "";
  const separator = raw.includes(";") ? ";" : ",";
  const values = raw
    .split(separator)
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : fallback.filter(Boolean);
}

const categories = listFromEnv("WC_CATEGORIES", [
  process.env.WC_DEFAULT_CATEGORY || "Uncategorized",
]);
const productBrands = listFromEnv("WC_PRODUCT_BRANDS", [
  process.env.WC_DEFAULT_PRODUCT_BRAND || "",
]);
const carBrands = listFromEnv("WC_CAR_BRANDS", [
  process.env.WC_DEFAULT_CAR_BRAND || "",
]);
const carModels = listFromEnv("WC_CAR_MODELS", [
  process.env.WC_DEFAULT_CAR_MODEL || "",
]);

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || "",
    allowedChatIds: (process.env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    requestTimeoutMs: numberFromEnv("TELEGRAM_REQUEST_TIMEOUT_MS", 20000),
    longPollTimeoutMs: numberFromEnv("TELEGRAM_LONG_POLL_TIMEOUT_MS", 40000),
    retryAttempts: numberFromEnv("TELEGRAM_RETRY_ATTEMPTS", 3),
  },

  scraper: {
    maxProducts: numberFromEnv("SCRAPER_MAX_PRODUCTS", 80),
    maxArchivePages: numberFromEnv("SCRAPER_MAX_ARCHIVE_PAGES", 1),
    navigationTimeoutMs: numberFromEnv("SCRAPER_NAVIGATION_TIMEOUT_MS", 45000),
    requestDelayMs: numberFromEnv("SCRAPER_REQUEST_DELAY_MS", 200),
    productConcurrency: numberFromEnv("SCRAPER_PRODUCT_CONCURRENCY", 4),
  },

  csvDefaults: {
    category: categories[0] || "Uncategorized",
    productBrand: productBrands[0] || "",
    carBrand: carBrands[0] || "",
    carModel: carModels[0] || "",
    priceMarkup: Number(process.env.WC_PRICE_MARKUP || 0),
    stockMode: process.env.WC_DEFAULT_STOCK_MODE || "backorder",
  },

  options: {
    categories,
    productBrands,
    carBrands,
    carModels,
    archivePages: listFromEnv("BOT_ARCHIVE_PAGE_OPTIONS", ["1", "2", "3", "5"]).map(Number).filter(Boolean),
    productLimits: listFromEnv("BOT_PRODUCT_LIMIT_OPTIONS", ["20", "40", "80", "150"]).map(Number).filter(Boolean),
    productConcurrency: listFromEnv("BOT_PRODUCT_CONCURRENCY_OPTIONS", ["2", "4", "6", "8"]).map(Number).filter(Boolean),
  },
};
