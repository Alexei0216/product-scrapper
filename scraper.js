const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const toCSV = require("./add-csv");

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cleanHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url, baseUrl) {
  try {
    if (!url || String(url).startsWith("data:")) return "";
    const parsed = new URL(url, baseUrl);
    if (parsed.hash && `${parsed.origin}${parsed.pathname}${parsed.search}` === baseUrl.split("#")[0]) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function isLikelyProductUrl(url, archiveUrl, score = 0) {
  try {
    const parsed = new URL(url);
    const archive = new URL(archiveUrl);
    if (parsed.origin !== archive.origin) return false;
    if (parsed.href.split("#")[0] === archive.href.split("#")[0]) return false;

    const lower = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif|svg|pdf|zip)(\?|$)/.test(lower)) return false;
    if (/(cart|checkout|account|login|register|wishlist|compare|comparers|settings\.php|privacy|terms|contact|about|blog)(\/|=|$)/.test(lower)) {
      return false;
    }

    const productSignal = /(product|products|prod|item|shop|sku|p-|\/p\/|\d{3,}|\.html?$)/.test(lower);
    const archiveSignal = /(category|catalog|collection|collections|tag|brand)(\/|=|$)/.test(lower);

    if (archiveSignal && !productSignal && score < 5) return false;
    return productSignal || score >= 5;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeImageUrl(url, baseUrl) {
  const cleaned = String(url || "")
    .replace(/\/cache\/[^/]+/g, "")
    .replace(/_\d+x\d+(?=\.[a-z]{3,4}($|\?))/i, "");

  return normalizeUrl(cleaned, baseUrl);
}

function imagePriority(url) {
  if (/[_/-]pl[_-]/i.test(url)) return 5;
  if (/[_/-]large[_-]/i.test(url)) return 4;
  if (/[_/-]pm[_-]/i.test(url)) return 3;
  if (/[_/-]ps[_-]/i.test(url)) return 2;
  return 1;
}

function imageGroupKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname
      .replace(/\/hpeciai\/[^/]+\//i, "/hpeciai/")
      .replace(/([_-])p[slm]([_-])/i, "$1p$2")
      .replace(/([_-])\d+x\d+([_.-])/i, "$1size$2");
  } catch {
    return url;
  }
}

function dedupeImageVariants(urls) {
  const byKey = new Map();

  for (const url of urls) {
    const key = imageGroupKey(url);
    const current = byKey.get(key);

    if (!current || imagePriority(url) > imagePriority(current)) {
      byKey.set(key, url);
    }
  }

  return [...byKey.values()];
}

async function delay(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectProductLinks(page, archiveUrl, options) {
  const maxArchivePages = options.maxArchivePages || config.scraper.maxArchivePages;
  const maxProducts = options.maxProducts || config.scraper.maxProducts;
  const visited = new Set();
  const productLinks = new Map();
  let nextUrl = archiveUrl;

  for (let pageIndex = 0; pageIndex < maxArchivePages && nextUrl; pageIndex += 1) {
    const currentUrl = normalizeUrl(nextUrl, archiveUrl);
    if (!currentUrl || visited.has(currentUrl)) break;
    visited.add(currentUrl);

    await options.progress?.(`Открываю архив ${pageIndex + 1}/${maxArchivePages}: ${currentUrl}`);
    await page.goto(currentUrl, {
      waitUntil: "domcontentloaded",
      timeout: options.navigationTimeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await delay(options.requestDelayMs);

    const extracted = await page.evaluate(() => {
      const text = (value) => (value || "").replace(/\s+/g, " ").trim();
      const samePage = (href) => {
        try {
          const url = new URL(href, location.href);
          url.hash = "";
          const current = new URL(location.href);
          current.hash = "";
          return url.href === current.href;
        } catch {
          return false;
        }
      };
      const urlsFromJsonLd = [];

      for (const script of document.querySelectorAll('script[type*="ld+json"]')) {
        try {
          const parsed = JSON.parse(script.textContent || "{}");
          const stack = Array.isArray(parsed) ? [...parsed] : [parsed];

          while (stack.length) {
            const item = stack.shift();
            if (!item || typeof item !== "object") continue;

            const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
            const itemUrl = item.url || item["@id"];
            if (/Product/i.test(type || "") && itemUrl) {
              urlsFromJsonLd.push(new URL(itemUrl, location.href).href);
            }
            if (Array.isArray(item.itemListElement)) stack.push(...item.itemListElement);
            if (item.item && typeof item.item === "object") stack.push(item.item);
            if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
          }
        } catch {}
      }

      const strongProductLinks = [];
      const strongSelectors = [
        "[data-product_id] a[href]",
        "[data-product-id][href]",
        "[data-product-id] a[href]",
        "a.product__name[href]",
        ".product a[href]",
        "[itemtype*='Product' i] a[href]",
      ];

      for (const selector of strongSelectors) {
        for (const anchor of document.querySelectorAll(selector)) {
          const href = anchor.href || anchor.getAttribute("href");
          if (!href || samePage(href)) continue;
          const cls = `${anchor.className || ""}`.toLowerCase();
          if (/compare|basket|cart|wishlist|settings/.test(cls + " " + href)) continue;
          strongProductLinks.push(new URL(href, location.href).href);
        }
      }

      const anchors = Array.from(document.querySelectorAll("a[href]")).map((anchor) => {
        const href = new URL(anchor.getAttribute("href"), location.href).href;
        if (samePage(href)) return { href, score: -100 };
        const label = text(anchor.innerText || anchor.getAttribute("aria-label") || anchor.getAttribute("title"));
        const cls = `${anchor.className || ""} ${anchor.id || ""}`.toLowerCase();
        const parent = anchor.closest('[data-product_id], [data-product-id], [itemtype*="Product" i], .product, [class*="product-card" i], [class*="product__" i]');
        const image = anchor.querySelector("img");
        let score = 0;

        if (parent) score += 5;
        if (image) score += 2;
        if (/product|prod|card|title|name|woocommerce-loop-product/.test(cls)) score += 4;
        if (/compare|basket|cart|wishlist|settings/.test(cls + " " + href)) score -= 10;
        if (label.length >= 8 && label.length <= 140) score += 1;
        if (anchor.querySelector('[itemprop="name"], [itemprop="image"]')) score += 3;

        return { href, score };
      });

      const next =
        document.querySelector('a[rel="next"]')?.href ||
        Array.from(document.querySelectorAll("a[href]")).find((anchor) =>
          /^(next|older|siguiente|suivant|weiter|далее|следующая|>|\u203a)$/i.test(text(anchor.innerText))
        )?.href ||
        "";

      return { anchors, strongProductLinks, urlsFromJsonLd, next };
    });

    for (const href of extracted.strongProductLinks) {
      const url = normalizeUrl(href, currentUrl);
      if (isLikelyProductUrl(url, archiveUrl, 20)) productLinks.set(url, 30);
    }

    for (const href of extracted.urlsFromJsonLd) {
      const url = normalizeUrl(href, currentUrl);
      if (isLikelyProductUrl(url, archiveUrl, 20)) productLinks.set(url, 20);
    }

    if (extracted.strongProductLinks.length === 0) {
      for (const anchor of extracted.anchors) {
        const url = normalizeUrl(anchor.href, currentUrl);
        if (!isLikelyProductUrl(url, archiveUrl, anchor.score)) continue;
        productLinks.set(url, Math.max(productLinks.get(url) || 0, anchor.score));
      }
    }

    nextUrl = extracted.next;
    if (productLinks.size >= maxProducts) break;
  }

  return [...productLinks.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxProducts)
    .map(([url]) => url);
}

async function extractProduct(page, url, options) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs,
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await delay(options.requestDelayMs);

  const raw = await page.evaluate(() => {
    const text = (value) => (value || "").replace(/\s+/g, " ").trim();
    const html = (element) => {
      if (!element) return "";
      const clone = element.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg, form, button").forEach((node) => node.remove());
      return clone.innerHTML || "";
    };
    const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
    const jsonProducts = [];

    const flatten = (value) => {
      const stack = Array.isArray(value) ? [...value] : [value];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;

        const type = Array.isArray(item["@type"]) ? item["@type"].join(" ") : item["@type"];
        if (/Product/i.test(type || "")) jsonProducts.push(item);
        if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
        if (Array.isArray(item.itemListElement)) stack.push(...item.itemListElement.map((entry) => entry.item || entry));
        if (item.mainEntity) stack.push(item.mainEntity);
      }
    };

    for (const script of document.querySelectorAll('script[type*="ld+json"]')) {
      try {
        flatten(JSON.parse(script.textContent || "{}"));
      } catch {}
    }

    const product = jsonProducts[0] || {};
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
    const priceCandidates = [
      offers.price,
      offers.lowPrice,
      offers.highPrice,
      meta('meta[property="product:price:amount"]'),
      ...Array.from(document.querySelectorAll('[itemprop="price"], [class*="price" i], [id*="price" i]'))
        .slice(0, 8)
        .map((node) => node.getAttribute("content") || node.textContent),
    ];

    const descriptionElement =
      document.querySelector('[itemprop="description"]') ||
      document.querySelector('[class*="description" i]') ||
      document.querySelector('[id*="description" i]') ||
      document.querySelector(".woocommerce-product-details__short-description") ||
      document.querySelector(".product-description");

    const skuText =
      product.sku ||
      product.mpn ||
      document.querySelector('[itemprop="sku"]')?.textContent ||
      text(document.body.innerText).match(/(?:SKU|Артикул|Referencia|Ref\.?|MPN)\s*[:#-]?\s*([A-Z0-9._-]{3,})/i)?.[1] ||
      "";

    const imageValues = [
      product.image,
      meta('meta[property="og:image"]'),
      ...Array.from(
        document.querySelectorAll(
          [
            'a[href]',
            'img[src]',
            'img[data-src]',
            'img[data-large]',
            'img[data-full]',
            'img[data-original]',
            'img[data-zoom-image]',
            'img[srcset]',
            'source[srcset]',
            '[data-src]',
            '[data-large]',
            '[data-full]',
            '[data-original]',
            '[data-zoom-image]',
          ].join(", ")
        )
      )
        .filter((node) => {
          const container = node.closest(
            [
              '[class*="product" i]',
              '[class*="gallery" i]',
              '[class*="thumb" i]',
              '[class*="photo" i]',
              '[class*="image" i]',
              '[id*="gallery" i]',
              '[id*="photo" i]',
              '[itemtype*="Product" i]',
              'main',
              'article',
            ].join(", ")
          );
          return container || node.getAttribute("itemprop") === "image";
        })
        .flatMap((node) => {
          const attrs = [
            "href",
            "src",
            "data-src",
            "data-large",
            "data-full",
            "data-original",
            "data-zoom-image",
            "data-image",
          ];
          const values = attrs.map((attr) => node.getAttribute(attr));
          const srcset = node.getAttribute("srcset");

          if (srcset) {
            values.push(
              ...srcset
                .split(",")
                .map((item) => item.trim().split(/\s+/)[0])
                .filter(Boolean)
            );
          }

          return values;
        }),
    ].flat();

    const breadcrumbs = Array.from(
      document.querySelectorAll('[aria-label*="breadcrumb" i] a, .breadcrumb a, .breadcrumbs a, [class*="breadcrumb" i] a')
    )
      .map((node) => text(node.textContent))
      .filter((value) => value && !/^home|inicio|главная$/i.test(value));

    return {
      name:
        product.name ||
        meta('meta[property="og:title"]') ||
        document.querySelector("h1")?.textContent ||
        document.title,
      price: priceCandidates.find((value) => /\d/.test(String(value || ""))) || "",
      sku: skuText,
      description: product.description || html(descriptionElement) || meta('meta[name="description"]'),
      shortDescription: meta('meta[name="description"]'),
      images: imageValues,
      categories: breadcrumbs.join(" > "),
    };
  });

  const images = dedupeImageVariants(unique(
    raw.images
      .map((imageUrl) => normalizeImageUrl(imageUrl, url))
      .filter((imageUrl) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(imageUrl))
      .filter((imageUrl) => !/placeholder|loading|spinner|logo|icon|sprite/i.test(imageUrl))
  )).slice(0, 30);

  return {
    sourceUrl: url,
    name: cleanText(raw.name),
    price: cleanText(raw.price).replace(/[^\d.,-]/g, ""),
    sku: cleanText(raw.sku) || `AUTO-${Buffer.from(url).toString("base64url").slice(0, 12)}`,
    description: cleanHtml(raw.description),
    shortDescription: cleanText(raw.shortDescription),
    categories: cleanText(raw.categories),
    images,
  };
}

async function scrape(input = {}) {
  const archiveUrls = unique([
    ...(Array.isArray(input.archiveUrls) ? input.archiveUrls : []),
    input.archiveUrl || input.url || "",
  ]);
  const options = {
    archiveUrl: archiveUrls[0] || "",
    archiveUrls,
    productUrls: input.productUrls || [],
    outputDir: input.outputDir || process.cwd(),
    maxProducts: input.maxProducts || config.scraper.maxProducts,
    maxArchivePages: input.maxArchivePages || config.scraper.maxArchivePages,
    navigationTimeoutMs: input.navigationTimeoutMs || config.scraper.navigationTimeoutMs,
    requestDelayMs: input.requestDelayMs ?? config.scraper.requestDelayMs,
    csvDefaults: input.csvDefaults || config.csvDefaults,
    progress: input.progress,
  };

  if (options.archiveUrls.length === 0 && options.productUrls.length === 0) {
    throw new Error("Нужна ссылка на архив товаров или список ссылок товаров.");
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const products = [];

  try {
    const page = await browser.newPage();
    let productUrls = options.productUrls.length ? options.productUrls : [];

    if (productUrls.length === 0) {
      const seen = new Set();

      for (let index = 0; index < options.archiveUrls.length; index += 1) {
        const archiveUrl = options.archiveUrls[index];
        const remaining = options.maxProducts - productUrls.length;
        if (remaining <= 0) break;

        await options.progress?.({
          stage: "archive",
          current: index + 1,
          total: options.archiveUrls.length,
          url: archiveUrl,
        });

        const links = await collectProductLinks(page, archiveUrl, {
          ...options,
          maxProducts: remaining,
        });

        for (const link of links) {
          if (!seen.has(link)) {
            seen.add(link);
            productUrls.push(link);
          }
        }
      }
    }
    await page.close();

    await options.progress?.({
      stage: "links",
      found: productUrls.length,
      total: productUrls.length,
    });

    for (let index = 0; index < productUrls.length; index += 1) {
      const url = productUrls[index];
      const productPage = await browser.newPage();

      try {
        await options.progress?.({
          stage: "product",
          current: index + 1,
          total: productUrls.length,
          url,
        });
        const product = await extractProduct(productPage, url, options);
        if (product.name && product.price) {
          products.push(product);
        } else {
          await options.progress?.({
            stage: "skip",
            current: index + 1,
            total: productUrls.length,
            url,
            reason: "нет названия или цены",
          });
        }
      } catch (error) {
        await options.progress?.({
          stage: "error",
          current: index + 1,
          total: productUrls.length,
          url,
          error: error.message,
        });
      } finally {
        await productPage.close();
      }
    }
  } finally {
    await browser.close();
  }

  const jsonFile = path.join(options.outputDir, "products.json");
  const csvFile = path.join(options.outputDir, "products.csv");

  fs.writeFileSync(jsonFile, JSON.stringify(products, null, 2), "utf8");
  toCSV(products, { outputFile: csvFile, defaults: options.csvDefaults });

  return { products, csvFile, jsonFile };
}

module.exports = scrape;
module.exports._internals = {
  collectProductLinks,
  isLikelyProductUrl,
  normalizeUrl,
};

if (require.main === module) {
  const archiveUrl = process.argv[2] || process.env.SCRAPER_URL || "";

  scrape({
    archiveUrl,
    outputDir: process.cwd(),
    progress: (message) => {
      if (typeof message === "string") {
        console.log(message);
        return;
      }

      if (message.stage === "archive") console.log(`Архив ${message.current}/${message.total}: ${message.url}`);
      if (message.stage === "links") console.log(`Нашел ссылок на товары: ${message.found}`);
      if (message.stage === "product") console.log(`Собираю товар ${message.current}/${message.total}`);
      if (message.stage === "skip") console.log(`Пропущен товар ${message.current}/${message.total}: ${message.reason}`);
      if (message.stage === "error") console.log(`Ошибка товара ${message.current}/${message.total}: ${message.error}`);
    },
  })
    .then(({ products, csvFile }) => {
      console.log(`Готово. Товаров: ${products.length}. CSV: ${csvFile}`);
    })
    .catch((error) => {
      console.error("Fatal scraper error:");
      console.error(error);
      process.exit(1);
    });
}
