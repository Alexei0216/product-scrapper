const fs = require("fs");
const path = require("path");
const config = require("./config");

function normalizePrice(price) {
  const raw = String(price || "").trim();
  if (!raw) return "";

  const value = Number(
    raw
      .replace(/[^\d,.-]/g, "")
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(value) ? value : "";
}

function addPriceMarkup(price, markup) {
  const value = normalizePrice(price);
  if (value === "") return "";

  return (value + Number(markup || 0)).toFixed(2);
}

function csvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
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
    "taxonomy=product_brand",
    "taxonomy=car_brand",
  ];

  const rows = products.map((product) => {
    const text = productText(product);
    const stock = stockValues(defaults.stockMode);

    return [
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
      defaults.productBrand,
      defaults.carBrand,
    ];
  });

  const csv = [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${csv}\n`, "utf8");

  return outputFile;
}

module.exports = toCSV;
