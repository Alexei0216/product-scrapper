const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const toCSV = require("./add-csv");
const scrape = require("./scraper");
const settingsStore = require("./settings-store");
const config = require("./config");
const { createQualityReport } = require("./quality-report");

const { addPriceMarkup, normalizePrice } = toCSV._internals;
const { customOptionVariants, primaryCustomOptions } = toCSV._internals;
const { autoSkuFromUrl, bestPrice, isLikelyProductUrl, normalizeCustomOptions, normalizeUrl, normalizeVariants, parsePriceValue } = scrape._internals;

assert.strictEqual(normalizePrice("1.234,56 EUR"), 1234.56);
assert.strictEqual(normalizePrice("$1,234.56"), 1234.56);
assert.strictEqual(normalizePrice("1.234"), 1234);
assert.strictEqual(addPriceMarkup("1,234.56", 10), "1244.56");
assert.strictEqual(parsePriceValue("1.234,56 EUR"), 1234.56);
assert.strictEqual(
  bestPrice([
    { text: "Save 20", source: "discount", score: 5 },
    { text: "€149,90", source: "json-ld offers.price", score: 80 },
  ]),
  "149.9"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "product-scrapper-"));
const csvFile = path.join(tempDir, "products.csv");
toCSV(
  [
    {
      sku: "SKU-1",
      name: "Zero price product",
      price: "0",
      description: "Description",
      shortDescription: "",
      categories: "Source category",
      images: ["https://example.com/a.jpg"],
    },
  ],
  {
    outputFile: csvFile,
    defaults: {
      category: "",
      productBrand: "",
      carBrand: "",
      carModel: "E46",
      priceMarkup: 0,
      stockMode: "instock",
    },
  }
);
const csv = fs.readFileSync(csvFile, "utf8");
assert.match(csv, /"taxonomy=car_model"/);
assert.match(csv, /"E46"/);
assert.match(csv, /"0\.00"/);

const variantCsvFile = path.join(tempDir, "variants.csv");
toCSV(
  [{
    sku: "PARENT-1",
    name: "Variable product",
    price: "10",
    description: "Description",
    images: ["https://example.com/main.jpg"],
    options: [{ name: "Colour", values: ["Black", "Silver"] }],
    variants: [
      { sku: "CHILD-B", price: "10", options: ["Black"], available: true, image: "https://example.com/black.jpg" },
      { sku: "CHILD-S", price: "12", options: ["Silver"], available: false },
    ],
  }],
  { outputFile: variantCsvFile, defaults: { priceMarkup: 0, stockMode: "instock" } }
);
const variantCsv = fs.readFileSync(variantCsvFile, "utf8");
assert.match(variantCsv, /"variable","PARENT-1"/);
assert.match(variantCsv, /"variation","CHILD-B"/);
assert.match(variantCsv, /"PARENT-1","Colour","Black"/);
assert.match(variantCsv, /"outofstock"/);

const conditionalCsvFile = path.join(tempDir, "conditional-variants.csv");
const conditionalProduct = {
  sku: "TYPE-1",
  name: "Conditional product",
  price: "100",
  customOptions: [
    { name: "Knob style", values: [{ name: "OG" }, { name: "GRIP" }] },
    {
      name: "OG Knob color",
      values: [{ name: "Red", price: "5" }, { name: "Blue" }],
      dependency: { match: "all", conditions: [{ option: "Knob style", value: "OG", operator: "equal" }] },
    },
  ],
};
assert.deepStrictEqual(customOptionVariants(conditionalProduct).map((variant) => variant.options), [
  ["OG", "Red"],
  ["OG", "Blue"],
  ["GRIP", ""],
]);
toCSV([conditionalProduct], { outputFile: conditionalCsvFile, defaults: { priceMarkup: 0, stockMode: "instock" } });
const conditionalCsv = fs.readFileSync(conditionalCsvFile, "utf8");
assert.strictEqual((conditionalCsv.match(/"variation"/g) || []).length, 3);
assert.match(conditionalCsv, /"variable","TYPE-1"/);
assert.match(conditionalCsv, /"TYPE-1","Knob style","OG","OG Knob color","Red"/);

const defaultTitleCsvFile = path.join(tempDir, "default-title-options.csv");
const defaultTitleProduct = {
  sku: "DEFAULT-1",
  name: "Default title product",
  price: "50",
  variants: [{ sku: "SHOPIFY-DEFAULT", price: "50", options: ["Default Title"] }],
  customOptions: [
    { name: "Mount", values: [{ name: "Standard" }] },
    { name: "Finish", values: [{ name: "Black" }] },
    { name: "Knob style", values: [{ name: "OG" }] },
    {
      name: "OG Knob color",
      values: [{ name: "Black" }, { name: "Yellow" }],
      dependency: { match: "all", conditions: [{ option: "Knob style", value: "OG", operator: "equal" }] },
    },
  ],
};
toCSV([defaultTitleProduct], { outputFile: defaultTitleCsvFile, defaults: { priceMarkup: 0, stockMode: "instock" } });
const defaultTitleCsv = fs.readFileSync(defaultTitleCsvFile, "utf8");
assert.doesNotMatch(defaultTitleCsv, /"Attribute 4 name"/);
assert.match(defaultTitleCsv, /"variable","DEFAULT-1"/);
assert.match(defaultTitleCsv, /"DEFAULT-1","Knob style","OG","OG Knob color","Black"/);

assert.deepStrictEqual(
  primaryCustomOptions({ customOptions: conditionalProduct.customOptions }).map((option) => option.name),
  ["Knob style", "OG Knob color"]
);
assert.deepStrictEqual(
  primaryCustomOptions({
    customOptions: [
      { name: "Bolt-on kit", values: [{ name: "No" }] },
      { name: "Bolt-on kit chassis", values: [{ name: "E30" }] },
      { name: "Knob style", values: [{ name: "OG" }] },
      { name: "OG Knob color", values: [{ name: "Black" }], dependency: { conditions: [{ option: "Knob style" }] } },
      { name: "Add ThermoShift knob?", values: [{ name: "Thank you" }] },
    ],
  }).map((option) => option.name),
  ["Knob style", "OG Knob color"]
);

assert.strictEqual(
  normalizeUrl("/product/demo#reviews", "https://example.com/shop/"),
  "https://example.com/product/demo"
);
assert.strictEqual(normalizeUrl("#details", "https://example.com/product/demo"), "");
assert.strictEqual(
  isLikelyProductUrl("https://example.com/product/demo", "https://example.com/shop/"),
  true
);
assert.strictEqual(
  isLikelyProductUrl("https://example.com/cart", "https://example.com/shop/", 20),
  false
);
assert.strictEqual(
  isLikelyProductUrl(
    "https://pmcmotorsport-shop.com/tra-spa-7631-BMW-Seria-3-E46.html",
    "https://pmcmotorsport-shop.com/spa_m_Suspension_Adaptadores-de-giro-Lock-Kits_Adaptadores-de-giro-BMW-Serie-3-E46-1726.html",
    20
  ),
  false
);
assert.strictEqual(
  isLikelyProductUrl(
    "https://pmcmotorsport-shop.com/product-spa-2535-Stage-3-Adaptadores-de-giro-BMW-E46-25.html",
    "https://pmcmotorsport-shop.com/spa_m_Suspension_Adaptadores-de-giro-Lock-Kits_Adaptadores-de-giro-BMW-Serie-3-E46-1726.html",
    20
  ),
  true
);
assert.notStrictEqual(
  autoSkuFromUrl("https://pmcmotorsport-shop.com/product-spa-2534-STAGE-3.html"),
  autoSkuFromUrl("https://pmcmotorsport-shop.com/product-spa-2561-Stage-2.html")
);
assert.deepStrictEqual(
  normalizeVariants(
    [{ id: 1, sku: "SHOPIFY-1", option1: "Race", option2: "E30", price: 9900, available: true }],
    [{ name: "Version" }, { name: "Chassis" }],
    "https://shop.example/products/demo",
    []
  ),
  {
    options: [{ name: "Version", values: ["Race"] }, { name: "Chassis", values: ["E30"] }],
    variants: [{ id: "1", sku: "SHOPIFY-1", price: "99", options: ["Race", "E30"], available: true, image: "" }],
  }
);

const report = createQualityReport([
  { sourceUrl: "https://example.com/p", name: "Example", price: "10", sku: "AUTO-123", images: [], variants: [], customOptions: [{}], confidence: 80 },
]);
assert.strictEqual(report.summary.productsWithWarnings, 1);
assert.strictEqual(report.summary.productsWithCustomOptions, 1);
assert.ok(report.products[0].warnings.includes("generated_parent_sku"));
assert.ok(!report.products[0].warnings.includes("custom_options_require_woocommerce_extension"));
assert.deepStrictEqual(
  normalizeCustomOptions(
    [{
      id: 2,
      type: "RadioImage",
      label: "OG Knob color",
      required: true,
      options: [{ name: "Black", image: "/black.webp" }],
      dependency: { match_type: "any", match_values: [{ element: "Knob style", value: "OG", operator: "equal" }] },
    }],
    "https://shop.example/products/demo"
  ),
  [{
    id: "2",
    name: "OG Knob color",
    type: "RadioImage",
    required: true,
    values: [{ name: "Black", image: "https://shop.example/black.webp", sourceImage: "/black.webp", price: "" }],
    dependency: { match: "any", conditions: [{ option: "Knob style", value: "OG", operator: "equal" }] },
  }]
);

const settings = settingsStore.getSettings();
assert.ok(Array.isArray(settings.categories));
assert.ok(Array.isArray(settings.archivePages));
assert.ok(Number.isFinite(config.scraper.productConcurrency));
assert.ok(Array.isArray(config.options.productConcurrency));

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("All tests passed.");
