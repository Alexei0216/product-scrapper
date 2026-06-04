process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const siteRules = require("./site-rules");
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
    if (/(cart|checkout|account|login|register|wishlist|compare|comparers|settings\.php|privacy|terms|contact|about|blog|search|filter)(\/|=|$)/.test(lower)) {
      return false;
    }

    const fileName = parsed.pathname.split("/").filter(Boolean).pop()?.toLowerCase() || "";
    const knownNonProductPage = /^(tra|cat|menu|news|blog|brand|producer|search|filter)-/.test(fileName);
    if (knownNonProductPage && !/^product-/.test(fileName)) return false;

    const strongProductSignal = /(^|\/)(product|products|prod|item|sku)(\/|-)|\/p\//.test(lower);
    const weakProductSignal = /(^|\/)shop\/.+\d{3,}|\.html?$|\d{3,}/.test(lower);
    const archiveSignal = /(category|catalog|collection|collections|tag|brand|vehicle|model)(\/|=|$)/.test(lower);

    if (archiveSignal && !strongProductSignal && score < 10) return false;
    return strongProductSignal || (weakProductSignal && score >= 5) || score >= 10;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hostFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function ruleFor(url) {
  const host = hostFor(url);
  return Object.entries(siteRules).find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] || {};
}

function safeFileName(value) {
  return String(value || "page")
    .replace(/^https?:\/\//i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "page";
}

function productConfidence(product) {
  let score = 0;
  if (product.name && product.name.length >= 3 && product.name.length <= 180) score += 30;
  if (product.price && /\d/.test(product.price)) score += 35;
  if (product.sku && !/^AUTO-/.test(product.sku)) score += 8;
  if (product.description && product.description.length >= 20) score += 10;
  if (product.images?.length) score += 12;
  if (product.categories) score += 5;
  return Math.min(100, score);
}

function shouldKeepProduct(product) {
  return product.name && product.price && product.confidence >= 50;
}

function createDiagnostics(options) {
  if (!options.debug) return null;
  const dir = path.join(options.outputDir, "debug");
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    async savePage(page, url, type, detail = {}) {
      const base = `${String(Date.now()).slice(-8)}-${type}-${safeFileName(url)}`;
      const jsonFile = path.join(dir, `${base}.json`);
      const htmlFile = path.join(dir, `${base}.html`);
      const pngFile = path.join(dir, `${base}.png`);

      fs.writeFileSync(jsonFile, JSON.stringify({ url, type, ...detail }, null, 2), "utf8");
      await page.content().then((html) => fs.writeFileSync(htmlFile, html, "utf8")).catch(() => {});
      await page.screenshot({ path: pngFile, fullPage: true }).catch(() => {});
    },
  };
}

function parsePriceValue(value) {
  const text = cleanText(value);
  if (!text || !/\d/.test(text)) return null;

  const match = text.match(/[-+]?\d[\d\s.,']*(?:[.,]\d{1,2})?/);
  if (!match) return null;

  let raw = match[0].replace(/\s|'/g, "");
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  const separatorIndex = Math.max(lastComma, lastDot);
  const digitsAfterSeparator = separatorIndex >= 0 ? raw.slice(separatorIndex + 1).replace(/\D/g, "").length : 0;
  const decimalSeparator = digitsAfterSeparator > 0 && digitsAfterSeparator <= 2 ? raw[separatorIndex] : "";

  if (decimalSeparator) {
    raw = raw.replace(new RegExp(`[^\\d${decimalSeparator === "." ? "\\." : ","}-]`, "g"), "");
    raw = raw.replace(decimalSeparator, ".");
  } else {
    raw = raw.replace(/[^\d-]/g, "");
  }

  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function bestPrice(candidates) {
  let best = null;

  for (const candidate of candidates || []) {
    const text = cleanText(candidate?.text ?? candidate);
    const value = parsePriceValue(text);
    if (value === null) continue;

    const source = String(candidate?.source || "").toLowerCase();
    const context = `${source} ${text}`.toLowerCase();
    let score = Number(candidate?.score || 0);

    if (/json-ld|schema|itemprop|product:price|og:price|current|regular|sale|price/.test(context)) score += 20;
    if (/old|was|before|strike|compare|save|discount|shipping|delivery|month|installment|finance|tax|vat|iva/.test(context)) score -= 18;
    if (value <= 0) score -= 8;
    if (value > 1000000) score -= 12;

    if (!best || score > best.score) best = { text, value, score };
  }

  return best ? String(best.value) : "";
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

function autoSkuFromUrl(url) {
  return `AUTO-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 12).toUpperCase()}`;
}

async function delay(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupFastContext(browser) {
  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.7,es;q=0.7",
    },
  });
  await context.route("**/*", (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (["media", "font", "stylesheet"].includes(resourceType)) {
      route.abort().catch(() => {});
      return;
    }

    if (/google-analytics|googletagmanager|facebook|doubleclick|hotjar|clarity|yandex|metrika/i.test(url)) {
      route.abort().catch(() => {});
      return;
    }

    route.continue().catch(() => {});
  });
  return context;
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
    const rule = ruleFor(currentUrl);

    for (let clickIndex = 0; clickIndex < 5 && rule.loadMoreSelector; clickIndex += 1) {
      const clicked = await page
        .locator(rule.loadMoreSelector)
        .first()
        .click({ timeout: 2500 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) break;
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await delay(options.requestDelayMs);
    }

    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let lastHeight = 0;

      for (let index = 0; index < 6; index += 1) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(250);
        const height = document.body.scrollHeight;
        if (height === lastHeight) break;
        lastHeight = height;
      }
      window.scrollTo(0, 0);
    }).catch(() => {});

    const extracted = await page.evaluate((rule) => {
      const text = (value) => (value || "").replace(/\s+/g, " ").trim();
      const all = (selector) => {
        try {
          return selector ? Array.from(document.querySelectorAll(selector)) : [];
        } catch {
          return [];
        }
      };
      const one = (selector) => all(selector)[0] || null;
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
        rule.productLinkSelector,
        "[data-product_id] a[href]",
        "[data-product-id][href]",
        "[data-product-id] a[href]",
        "a.product__name[href]",
        ".product a[href]",
        "[itemtype*='Product' i] a[href]",
        "[class*='product-card' i] a[href]",
        "[class*='product-item' i] a[href]",
        "[class*='product-tile' i] a[href]",
        "[class*='catalog-item' i] a[href]",
      ].filter(Boolean);

      for (const selector of strongSelectors) {
        for (const anchor of all(selector)) {
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
        const parent = anchor.closest('[data-product_id], [data-product-id], [itemtype*="Product" i], .product, [class*="product-card" i], [class*="product-item" i], [class*="product-tile" i], [class*="catalog-item" i], [class*="product__" i]');
        const image = anchor.querySelector("img");
        let score = 0;

        if (parent) score += 5;
        if (image) score += 2;
        if (/product|prod|card|tile|item|catalog|title|name|woocommerce-loop-product/.test(cls)) score += 4;
        if (/compare|basket|cart|wishlist|settings/.test(cls + " " + href)) score -= 10;
        if (label.length >= 8 && label.length <= 140) score += 1;
        if (anchor.querySelector('[itemprop="name"], [itemprop="image"]')) score += 3;
        if (parent?.querySelector('[class*="price" i], [itemprop="price"]')) score += 4;

        return { href, score };
      });

      const next =
        (rule.nextSelector ? one(rule.nextSelector)?.href : "") ||
        document.querySelector('a[rel="next"]')?.href ||
        Array.from(document.querySelectorAll("a[href]")).find((anchor) =>
          /^(next|older|siguiente|suivant|weiter|далее|следующая|>|\u203a)$/i.test(text(anchor.innerText))
        )?.href ||
        "";

      return { anchors, strongProductLinks, urlsFromJsonLd, next };
    }, rule);

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
  const apiProducts = [];
  const collectApiProduct = async (response) => {
    try {
      const headers = response.headers();
      const responseUrl = response.url();
      if (!/json/i.test(headers["content-type"] || "") && !/product|catalog|graphql|api/i.test(responseUrl)) return;

      const payload = await response.json();
      const stack = Array.isArray(payload) ? [...payload] : [payload];
      let scanned = 0;

      while (stack.length && scanned < 800) {
        scanned += 1;
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;

        const hasProductShape =
          item.name || item.title || item.sku || item.mpn || item.price || item.amount || item.images || item.image;
        if (hasProductShape && (item.price || item.offers || item.variants || item.images || item.image)) {
          apiProducts.push(item);
          if (apiProducts.length >= 20) break;
        }

        for (const value of Object.values(item)) {
          if (value && typeof value === "object") {
            if (Array.isArray(value)) stack.push(...value.slice(0, 50));
            else stack.push(value);
          }
        }
      }
    } catch {}
  };

  page.on("response", collectApiProduct);

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: options.navigationTimeoutMs,
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await delay(options.requestDelayMs);
  await page.evaluate(() => {
    window.scrollTo(0, Math.min(document.body.scrollHeight, 1600));
  }).catch(() => {});
  await delay(Math.min(500, options.requestDelayMs + 200));

  const rule = ruleFor(url);

  const raw = await page.evaluate((rule) => {
    const text = (value) => (value || "").replace(/\s+/g, " ").trim();
    const all = (selector) => {
      try {
        return selector ? Array.from(document.querySelectorAll(selector)) : [];
      } catch {
        return [];
      }
    };
    const one = (selector) => all(selector)[0] || null;
    const html = (element) => {
      if (!element) return "";
      const clone = element.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg, form, button").forEach((node) => node.remove());
      return clone.innerHTML || "";
    };
    const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || "";
    const firstText = (selector) => text(one(selector)?.textContent);
    const firstHtml = (selector) => html(one(selector));
    const jsonProducts = [];
    const imageUrlsFromValue = (value) => {
      if (!value) return [];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(imageUrlsFromValue);
      if (typeof value === "object") {
        return imageUrlsFromValue(value.url || value.contentUrl || value["@id"]);
      }
      return [];
    };

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
      { text: offers.price, source: "json-ld offers.price", score: 80 },
      { text: offers.lowPrice, source: "json-ld offers.lowPrice", score: 65 },
      { text: offers.highPrice, source: "json-ld offers.highPrice", score: 50 },
      { text: meta('meta[property="product:price:amount"]'), source: "product meta", score: 75 },
      { text: meta('meta[property="og:price:amount"]'), source: "og price", score: 65 },
      { text: firstText(rule.priceSelector), source: "site rule", score: 90 },
      ...Array.from(document.querySelectorAll('[itemprop="price"], [class*="price" i], [id*="price" i]'))
        .slice(0, 8)
        .map((node) => ({
          text: node.getAttribute("content") || node.textContent,
          source: `${node.tagName}.${node.className || ""}#${node.id || ""}`,
          score: node.matches('[itemprop="price"]') ? 65 : 35,
        })),
    ];

    const descriptionElement =
      one(rule.descriptionSelector) ||
      document.querySelector('[itemprop="description"]') ||
      document.querySelector('[class*="description" i]') ||
      document.querySelector('[id*="description" i]') ||
      document.querySelector(".woocommerce-product-details__short-description") ||
      document.querySelector(".product-description");

    const skuText =
      firstText(rule.skuSelector) ||
      product.sku ||
      product.mpn ||
      document.querySelector('[itemprop="sku"]')?.textContent ||
      text(document.body.innerText).match(/(?:SKU|Артикул|Referencia|Ref\.?|MPN)\s*[:#-]?\s*([A-Z0-9._-]{3,})/i)?.[1] ||
      "";

    const imageValues = [
      ...imageUrlsFromValue(product.image),
      meta('meta[property="og:image"]'),
      ...all(rule.imageSelector)
        .flatMap((node) => [
          node.getAttribute("href"),
          node.getAttribute("src"),
          node.getAttribute("data-src"),
          node.getAttribute("data-large"),
          node.getAttribute("data-full"),
          node.getAttribute("data-original"),
          node.getAttribute("data-zoom-image"),
        ]),
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
        firstText(rule.nameSelector) ||
        product.name ||
        meta('meta[property="og:title"]') ||
        document.querySelector("h1")?.textContent ||
        document.title,
      priceCandidates,
      sku: skuText,
      description: product.description || firstHtml(rule.descriptionSelector) || html(descriptionElement) || meta('meta[name="description"]'),
      shortDescription: firstText(rule.shortDescriptionSelector) || meta('meta[name="description"]'),
      images: imageValues,
      categories: breadcrumbs.join(" > "),
    };
  }, rule);

  const apiImageValues = [];
  const apiPriceCandidates = [];
  let apiName = "";
  let apiSku = "";
  let apiDescription = "";

  for (const item of apiProducts) {
    apiName ||= cleanText(item.name || item.title);
    apiSku ||= cleanText(item.sku || item.mpn || item.reference);
    apiDescription ||= cleanText(item.description || item.shortDescription || item.body_html);
    apiPriceCandidates.push(
      { text: item.price, source: "api price", score: 70 },
      { text: item.price?.amount || item.price?.value, source: "api price object", score: 68 },
      { text: item.amount, source: "api amount", score: 55 },
      { text: item.offers?.price, source: "api offers.price", score: 75 },
      { text: item.offers?.priceSpecification?.price, source: "api priceSpecification.price", score: 70 },
      { text: item.variants?.[0]?.price, source: "api variant.price", score: 70 },
      { text: item.variants?.[0]?.price?.amount || item.variants?.[0]?.price?.value, source: "api variant.price object", score: 68 }
    );

    const images = item.images || item.image || item.media || [];
    const values = Array.isArray(images) ? images : [images];
    for (const image of values) {
      if (typeof image === "string") apiImageValues.push(image);
      if (image && typeof image === "object") apiImageValues.push(image.url || image.src || image.originalSrc);
    }
  }

  const images = dedupeImageVariants(unique(
    [...raw.images, ...apiImageValues]
      .map((imageUrl) => normalizeImageUrl(imageUrl, url))
      .filter((imageUrl) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(imageUrl))
      .filter((imageUrl) => !/placeholder|loading|spinner|logo|icon|sprite/i.test(imageUrl))
  )).slice(0, 30);

  const product = {
    sourceUrl: url,
    name: cleanText(raw.name) || apiName,
    price: bestPrice([...(raw.priceCandidates || []), ...apiPriceCandidates]),
    sku: cleanText(raw.sku) || apiSku || autoSkuFromUrl(url),
    description: cleanHtml(raw.description) || apiDescription,
    shortDescription: cleanText(raw.shortDescription),
    categories: cleanText(raw.categories),
    images,
    extraction: {
      confidence: 0,
      apiCandidates: apiProducts.length,
      hasSiteRule: Object.keys(rule).length > 0,
    },
  };

  product.confidence = productConfidence(product);
  product.extraction.confidence = product.confidence;
  return product;
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
    productConcurrency: input.productConcurrency || config.scraper.productConcurrency,
    csvDefaults: input.csvDefaults || config.csvDefaults,
    debug: input.debug ?? config.scraper.debug,
    progress: input.progress,
  };

  if (options.archiveUrls.length === 0 && options.productUrls.length === 0) {
    throw new Error("Нужна ссылка на архив товаров или список ссылок товаров.");
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  const diagnostics = createDiagnostics(options);
  const browser = await chromium.launch({ headless: true });
  const context = await setupFastContext(browser);
  const products = [];

  try {
    const page = await context.newPage();
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

    let nextProductIndex = 0;
    let completed = 0;
    let saved = 0;
    let skipped = 0;
    let errors = 0;
    const results = new Array(productUrls.length);
    const concurrency = Math.max(1, Math.min(options.productConcurrency, productUrls.length || 1));

    async function worker() {
      while (nextProductIndex < productUrls.length) {
        const index = nextProductIndex;
        nextProductIndex += 1;

        const url = productUrls[index];
        const productPage = await context.newPage();

        await options.progress?.({
          stage: "product_start",
          current: index + 1,
          total: productUrls.length,
          url,
          active: Math.min(concurrency, productUrls.length - completed),
        });

        try {
          const product = await extractProduct(productPage, url, options);
          if (shouldKeepProduct(product)) {
            results[index] = product;
            saved += 1;
          } else {
            skipped += 1;
            const reason = [
              product.name ? "" : "missing name",
              product.price ? "" : "missing price",
              product.confidence < 50 ? `low confidence ${product.confidence}` : "",
            ].filter(Boolean).join(", ") || "no reliable product data";
            await diagnostics?.savePage(productPage, url, "skip", { reason, product });
            await options.progress?.({
              stage: "skip",
              current: completed + 1,
              total: productUrls.length,
              url,
              reason,
              saved,
              skipped,
              errors,
            });
          }
        } catch (error) {
          errors += 1;
          await diagnostics?.savePage(productPage, url, "error", { error: error.message });
          await options.progress?.({
            stage: "error",
            current: completed + 1,
            total: productUrls.length,
            url,
            error: error.message,
            saved,
            skipped,
            errors,
          });
        } finally {
          completed += 1;
          await productPage.close().catch(() => {});
          await options.progress?.({
            stage: "product_done",
            current: completed,
            total: productUrls.length,
            url,
            saved,
            skipped,
            errors,
            active: Math.max(0, Math.min(concurrency, productUrls.length - completed)),
          });
        }
      }
    }

    if (productUrls.length > 0) {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      products.push(...results.filter(Boolean));
    }
  } finally {
    await context.close().catch(() => {});
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
  autoSkuFromUrl,
  isLikelyProductUrl,
  normalizeUrl,
  parsePriceValue,
  bestPrice,
  setupFastContext,
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
      if (message.stage === "product_start") console.log(`Старт товара ${message.current}/${message.total}`);
      if (message.stage === "product_done") console.log(`Готово товаров ${message.current}/${message.total}`);
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
