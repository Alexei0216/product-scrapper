const fs = require("fs");
const path = require("path");
const config = require("./config");

function normalizePrice(price) {
  const raw = String(price || "").trim();
  if (!raw) return "";

  const cleaned = raw.replace(/[^\d,.-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const separatorIndex = Math.max(lastComma, lastDot);
  const digitsAfterSeparator =
    separatorIndex >= 0 ? cleaned.slice(separatorIndex + 1).replace(/\D/g, "").length : 0;
  const decimalSeparator = digitsAfterSeparator === 3 ? "" : lastComma > lastDot ? "," : ".";
  const numeric = cleaned.replace(
    new RegExp(`[^\\d${decimalSeparator === "." ? "\\." : decimalSeparator}-]`, "g"),
    ""
  );
  const normalized = decimalSeparator ? numeric.replace(decimalSeparator, ".") : numeric;
  const value = Number(normalized);

  return Number.isFinite(value) ? value : "";
}

function addPriceMarkup(price, markup) {
  const value = normalizePrice(price);
  if (value === "") return "";

  return (value + Number(markup || 0)).toFixed(2);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function productText(product) {
  return product.description || product.shortDescription || product.name || "";
}

function stockValues(stockMode) {
  if (stockMode === "instock") {
    return {
      inStock: "1",
      backorders: "no",
      status: "instock",
    };
  }

  if (stockMode === "outofstock") {
    return {
      inStock: "0",
      backorders: "no",
      status: "outofstock",
    };
  }

  return {
    inStock: "1",
    backorders: "notify",
    status: "onbackorder",
  };
}

function attributeColumns(attributes) {
  const columns = [];
  for (let index = 0; index < 3; index += 1) {
    const attribute = attributes[index] || {};
    columns.push(attribute.name || "", (attribute.values || []).join(", "));
  }
  return columns;
}

function productAttributes(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  return (product.options || [])
    .map((option, index) => ({
      name: option.name || `Option ${index + 1}`,
      values: option.values?.length
        ? option.values
        : [...new Set(variants.map((variant) => variant.options?.[index]).filter(Boolean))],
    }))
    .filter((option) => option.values.length);
}

function toCSV(products, options = {}) {
  const defaults = {
    ...config.csvDefaults,
    ...(options.defaults || {}),
  };
  const outputFile = options.outputFile || path.resolve("products.csv");

  const header = [
    "Type",
    "SKU",
    "Name",
    "Published",
    "Short description",
    "Description",
    "Regular price",
    "Categories",
    "Images",
    "In stock?",
    "Backorders allowed?",
    "Stock status",
    "Parent",
    "Attribute 1 name",
    "Attribute 1 value(s)",
    "Attribute 2 name",
    "Attribute 2 value(s)",
    "Attribute 3 name",
    "Attribute 3 value(s)",
    "taxonomy=product_brand",
    "taxonomy=car_brand",
    "taxonomy=car_model",
  ];

  const rows = products.flatMap((product) => {
    const text = productText(product);
    const stock = stockValues(defaults.stockMode);
    const attributes = productAttributes(product);
    const variants = Array.isArray(product.variants) ? product.variants : [];

    if (!variants.length) return [[
      "simple",
      product.sku,
      product.name,
      "1",
      product.shortDescription || text,
      text,
      addPriceMarkup(product.price, defaults.priceMarkup),
      defaults.category || product.categories,
      Array.isArray(product.images) ? product.images.join(", ") : "",
      stock.inStock,
      stock.backorders,
      stock.status,
      "",
      ...attributeColumns([]),
      defaults.productBrand,
      defaults.carBrand,
      defaults.carModel,
    ]];

    const parentRow = [
      "variable",
      product.sku,
      product.name,
      "1",
      product.shortDescription || text,
      text,
      "",
      defaults.category || product.categories,
      Array.isArray(product.images) ? product.images.join(", ") : "",
      stock.inStock,
      stock.backorders,
      stock.status,
      "",
      ...attributeColumns(attributes),
      defaults.productBrand,
      defaults.carBrand,
      defaults.carModel,
    ];
    const variantRows = variants.map((variant) => {
      const variantStock = variant.available === false ? stockValues("outofstock") : stock;
      const variantAttributes = attributes.map((attribute, index) => ({
        name: attribute.name,
        values: [variant.options?.[index] || ""].filter(Boolean),
      }));
      return [
        "variation",
        variant.sku,
        product.name,
        "1",
        "",
        "",
        addPriceMarkup(variant.price || product.price, defaults.priceMarkup),
        "",
        variant.image || "",
        variantStock.inStock,
        variantStock.backorders,
        variantStock.status,
        product.sku,
        ...attributeColumns(variantAttributes),
        "",
        "",
        "",
      ];
    });
    return [parentRow, ...variantRows];
  });

  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${csv}\n`, "utf8");

  return outputFile;
}

module.exports = toCSV;
module.exports._internals = {
  addPriceMarkup,
  normalizePrice,
  stockValues,
  productAttributes,
};
