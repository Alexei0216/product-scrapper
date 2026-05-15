const { chromium } = require("playwright");
const fs = require("fs");
const https = require("https");
const path = require("path");
const config = require("./config");

console.log("🚀 SCRIPT STARTED");

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanPrice(price) {
  return (price || "").replace(/[^\d.,]/g, "").trim();
}

function cleanHtml(html) {
  return (html || "").replace(/\s+/g, " ").trim();
}

function normalizeImage(url) {
  if (!url) return "";

  return url.replace(/\/cache\/[^/]+/g, "");
}

function downloadImage(url, filename) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(filename);

    https
      .get(url, (response) => {
        response.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", () => {
        fs.unlink(filename, () => {});
        resolve();
      });
  });
}

async function collectProductLinks(browser) {
  const links = new Set();

  if (!config.listPages || config.listPages.length === 0) {
    console.log("ℹ️  Нет страниц каталога. Используются ссылки из pages.");
    return config.pages.filter(Boolean);
  }

  console.log("🔗 Сбор ссылок товаров со страниц каталога...");

  for (const catalogUrl of config.listPages) {
    try {
      const page = await browser.newPage();
      console.log("Загружаю каталог:", catalogUrl);

      await page.goto(catalogUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);

      const productLinks = await page.evaluate((selector) => {
        return Array.from(document.querySelectorAll(selector))
          .map((el) => el.getAttribute("href"))
          .filter(Boolean)
          .map((href) => {
            try {
              return new URL(href, window.location.href).href;
            } catch {
              return href;
            }
          })
          .filter(url => url && url.startsWith('http'));  // Только валидные URL
      }, config.selectors.productLinks);

      console.log(`✔ Найдено товаров: ${productLinks.length}`);

      productLinks.forEach((link) => links.add(link));
      await page.close();
    } catch (err) {
      console.log("❌ Ошибка при загрузке каталога:", catalogUrl, err.message);
    }
  }

  const allLinks = [...links, ...config.pages];
  console.log(`📦 Всего товаров для обработки: ${allLinks.length}`);

  return allLinks;
}

async function scrape() {
  if (fs.existsSync("products.json")) fs.unlinkSync("products.json");
  if (fs.existsSync("products.csv")) fs.unlinkSync("products.csv");

  if (fs.existsSync("images")) {
    fs.rmSync("images", { recursive: true, force: true });
  }
  fs.mkdirSync("images");

  console.log("Launching browser...");
  const browser = await chromium.launch({
    headless: true,
  });

  // Собираем ссылки на товары
  const productUrls = await collectProductLinks(browser);

  let allProducts = [];

  for (const url of productUrls) {
    // Пропускаем пустые ссылки
    if (!url) {
      console.log("⚠️ Пустая ссылка, пропускаю");
      continue;
    }

    console.log("Scraping:", url);

    const page = await browser.newPage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      const titleExists = await page.$(config.selectors.title);
      if (!titleExists) {
        console.log("⚠️ No product found:", url);
        continue;
      }

      await page.waitForTimeout(1000);

      const product = await page.evaluate(({ sel, pageUrl }) => {
        const title = document.querySelector(sel.title)?.innerText || "";

        const priceEl = document.querySelector(sel.price);
        const price = priceEl ? priceEl.textContent : "";

        const sku = document.querySelector(sel.sku)?.innerText || "";

        const descriptionEl = document.querySelector(sel.description);
        const descriptionClone = descriptionEl?.cloneNode(true);

        descriptionClone
          ?.querySelectorAll("script, style, noscript")
          .forEach((el) => el.remove());

        const description = descriptionClone?.innerHTML || "";

        const images = [
          ...new Set(
            Array.from(document.querySelectorAll(sel.images))
              .map(
                (img) =>
                  img.getAttribute("src") || img.getAttribute("data-src")
              )
              .map((url) => url && url.replace(/\/cache\/[^/]+/g, ""))
              .map((url) => {
                try {
                  // Пропускаем data: URI (встроенные изображения)
                  if (!url || url.startsWith("data:")) return "";
                  return new URL(url, pageUrl).href;
                } catch {
                  return "";
                }
              })
              .filter(Boolean)
          ),
        ];

        return { title, price, sku, description, images };
      }, { sel: config.selectors, pageUrl: url });

      const localImages = [];
      const safeSku = cleanText(product.sku).replace(/[^\w.-]/g, "_");

      for (let i = 0; i < product.images.length; i++) {
        const imgUrl = normalizeImage(product.images[i]);
        const filename = path.join(
          "images",
          `${safeSku || Date.now()}_${i}.jpg`
        );

        await downloadImage(imgUrl, filename);

        localImages.push(filename);
      }

      allProducts.push({
        name: cleanText(product.title),
        price: cleanPrice(product.price),
        sku: cleanText(product.sku),
        description: cleanHtml(product.description),
        images: product.images,
        localImages,
        category: config.defaults.category,
        brand: config.defaults.brand,
        carBrand: config.defaults.carBrand,
      });
    } catch (err) {
      console.log("❌ Error on:", url, err.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // JSON
  fs.writeFileSync("products.json", JSON.stringify(allProducts, null, 2));

  console.log(`✔ JSON saved: ${allProducts.length} products`);

  // CSV
  const toCSV = require("./add-csv");
  toCSV(allProducts);

  return allProducts;
}

module.exports = scrape;

if (require.main === module) {
  scrape().catch((err) => {
    console.error("Fatal scraper error:");
    console.error(err);
    process.exit(1);
  });
}
