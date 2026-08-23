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

function attributeColumns(attributes, count = 3) {
  const columns = [];
  for (let index = 0; index < count; index += 1) {
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

function customOptionAttributes(product) {
  return (product.customOptions || [])
    .map((option) => ({
      name: option.name,
      values: (option.values || []).map((value) => value.name).filter(Boolean),
    }))
    .filter((option) => option.name && option.values.length);
}

function conditionMatches(condition, selected) {
  const actual = selected.get(condition.option) || "";
  const expected = condition.value || "";
  switch (String(condition.operator || "equal").toLowerCase()) {
    case "not_equal":
    case "not-equal":
    case "neq":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    default:
      return actual === expected;
  }
}

function customOptionIsVisible(option, selected) {
  const dependency = option.dependency;
  if (!dependency?.conditions?.length) return true;
  const matches = dependency.conditions.map((condition) => conditionMatches(condition, selected));
  return dependency.match === "any" ? matches.some(Boolean) : matches.every(Boolean);
}

function customOptionVariants(product) {
  const options = (product.customOptions || []).filter((option) => option.name && option.values?.length);
  if (!options.length) return [];

  const combinations = [];
  function build(index, selected, values, priceAdditions, image) {
    if (index === options.length) {
      combinations.push({ values, priceAdditions, image });
      return;
    }

    const option = options[index];
    if (!customOptionIsVisible(option, selected)) {
      build(index + 1, selected, [...values, ""], priceAdditions, image);
      return;
    }

    for (const value of option.values) {
      const name = value.name || "";
      selected.set(option.name, name);
      build(
        index + 1,
        selected,
        [...values, name],
        [...priceAdditions, value.price || ""],
        image || value.image || ""
      );
      selected.delete(option.name);
    }
  }
  build(0, new Map(), [], [], "");

  return combinations.map((combination, index) => ({
    sku: `${product.sku}-V-${String(index + 1).padStart(3, "0")}`,
    price: combination.priceAdditions.reduce(
      (total, addition) => total + (normalizePrice(addition) || 0),
      normalizePrice(product.price) || 0
    ),
    options: combination.values,
    available: true,
    image: combination.image,
  }));
}

function sourceCustomOptions(product) {
  const options = Array.isArray(product.customOptions) ? product.customOptions : [];
  return options.length ? JSON.stringify(options) : "";
}

function isPlaceholderVariant(variant) {
  return variant?.options?.length === 1 && /^default title$/i.test(String(variant.options[0] || "").trim());
}

function toCSV(products, options = {}) {
  const defaults = {
    ...config.csvDefaults,
    ...(options.defaults || {}),
  };
  const outputFile = options.outputFile || path.resolve("products.csv");
  const productAttributeSets = products.map((product) => {
    const sourceVariants = (Array.isArray(product.variants) ? product.variants : [])
      .filter((variant) => !isPlaceholderVariant(variant));
    return sourceVariants.length ? productAttributes(product) : customOptionAttributes(product);
  });
  const attributeCount = Math.max(3, ...productAttributeSets.map((attributes) => attributes.length));

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
    ...Array.from({ length: attributeCount }, (_, index) => [
      `Attribute ${index + 1} name`,
      `Attribute ${index + 1} value(s)`,
    ]).flat(),
    "Meta: source_custom_options",
    "Meta: source_url",
    "taxonomy=product_brand",
    "taxonomy=car_brand",
    "taxonomy=car_model",
  ];

  const rows = products.flatMap((product) => {
    const text = productText(product);
    const stock = stockValues(defaults.stockMode);
    const sourceVariants = (Array.isArray(product.variants) ? product.variants : [])
      .filter((variant) => !isPlaceholderVariant(variant));
    const generatedVariants = customOptionVariants(product);
    const variants = sourceVariants.length ? sourceVariants : generatedVariants;
    const attributes = sourceVariants.length ? productAttributes(product) : customOptionAttributes(product);

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
      ...attributeColumns([], attributeCount),
      sourceCustomOptions(product),
      product.sourceUrl || "",
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
      ...attributeColumns(attributes, attributeCount),
      sourceCustomOptions(product),
      product.sourceUrl || "",
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
        ...attributeColumns(variantAttributes, attributeCount),
        ...Array(5).fill(""),
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
  customOptionAttributes,
  customOptionVariants,
  sourceCustomOptions,
};
