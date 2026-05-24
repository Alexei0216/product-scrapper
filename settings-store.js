const fs = require("fs");
const path = require("path");
const config = require("./config");

const settingsFile = path.join(process.cwd(), "data", "bot-settings.json");

const defaults = {
  categories: config.options.categories,
  productBrands: config.options.productBrands,
  carBrands: config.options.carBrands,
  archivePages: config.options.archivePages,
  productLimits: config.options.productLimits,
};

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeSettings(settings = {}) {
  return {
    categories: unique(settings.categories || defaults.categories),
    productBrands: unique(settings.productBrands || defaults.productBrands),
    carBrands: unique(settings.carBrands || defaults.carBrands),
    archivePages: unique(settings.archivePages || defaults.archivePages).map(Number).filter(Boolean),
    productLimits: unique(settings.productLimits || defaults.productLimits).map(Number).filter(Boolean),
  };
}

function readSettings() {
  if (!fs.existsSync(settingsFile)) return normalizeSettings(defaults);

  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, "utf8")));
  } catch {
    return normalizeSettings(defaults);
  }
}

function writeSettings(settings) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function getSettings() {
  return readSettings();
}

function addOption(key, value) {
  const settings = readSettings();
  settings[key] = unique([...(settings[key] || []), value]);
  return writeSettings(settings);
}

function removeOption(key, index) {
  const settings = readSettings();
  settings[key] = (settings[key] || []).filter((_, itemIndex) => itemIndex !== index);
  return writeSettings(settings);
}

module.exports = {
  getSettings,
  addOption,
  removeOption,
};
