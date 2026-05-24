const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const toCSV = require("./add-csv");
const scrape = require("./scraper");
const settingsStore = require("./settings-store");
const config = require("./config");

const { addPriceMarkup, normalizePrice } = toCSV._internals;
const { autoSkuFromUrl, isLikelyProductUrl, normalizeUrl } = scrape._internals;

assert.strictEqual(normalizePrice("1.234,56 EUR"), 1234.56);
assert.strictEqual(normalizePrice("$1,234.56"), 1234.56);
assert.strictEqual(normalizePrice("1.234"), 1234);
assert.strictEqual(addPriceMarkup("1,234.56", 10), "1244.56");

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

const settings = settingsStore.getSettings();
assert.ok(Array.isArray(settings.categories));
assert.ok(Array.isArray(settings.archivePages));
assert.ok(Number.isFinite(config.scraper.productConcurrency));
assert.ok(Array.isArray(config.options.productConcurrency));

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("All tests passed.");
