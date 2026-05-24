# Product Scrapper Telegram Bot

Telegram bot that receives a product archive/category URL, finds product cards, extracts product data, and returns a WooCommerce import CSV.

## Setup

1. Install dependencies:

```bash
npm install
npx playwright install chromium
```

2. Create your Telegram bot with `@BotFather` and copy the token.

3. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

4. Put the token into `.env`:

```env
TELEGRAM_BOT_TOKEN=123456789:your_real_token
```

5. Optional but recommended: restrict access to your chat id.
   Start the bot once with `ALLOWED_CHAT_IDS=` empty, send `/start`, read the chat id from logs if you add logging, or use `@userinfobot`, then set:

```env
ALLOWED_CHAT_IDS=123456789
```

## Run

```bash
npm start
```

Send the bot a URL like:

```text
https://example.com/shop/category/
```

You can also send up to 10 archive URLs in one message:

```text
https://example.com/shop/category-a/
https://example.com/shop/category-b/
https://example.com/shop/category-c/
```

The bot will show an inline setup panel where you can choose:

- WooCommerce category.
- Product brand taxonomy.
- Car brand taxonomy.
- Stock mode: in stock, preorder/backorder, or out of stock.
- How many archive pages to scan.
- Product limit for this run.
- New categories/brands can be added from Telegram without code changes.

Then the bot will reply with:

- `products.csv` ready for WooCommerce import.
- `products.json` with raw collected product data.

During scraping, the bot edits one progress message instead of sending a new message for every product.

WooCommerce import path: `Products -> Import -> Upload CSV`.

## CLI Scrape

You can run the scraper without Telegram:

```bash
npm run scrape -- "https://example.com/shop/category/"
```

The CLI writes `products.csv` and `products.json` into the project root.

## Configuration

All production settings are in `.env`:

- `TELEGRAM_BOT_TOKEN` - token from `@BotFather`.
- `ALLOWED_CHAT_IDS` - optional comma-separated Telegram chat ids.
- `SCRAPER_MAX_PRODUCTS` - max products per link.
- `SCRAPER_MAX_ARCHIVE_PAGES` - how many archive/pagination pages to scan.
- `WC_DEFAULT_CATEGORY` - fallback WooCommerce category.
- `WC_DEFAULT_PRODUCT_BRAND` - value for `taxonomy=product_brand`.
- `WC_DEFAULT_CAR_BRAND` - value for `taxonomy=car_brand`.
- `WC_PRICE_MARKUP` - fixed amount added to each parsed price.
- `WC_DEFAULT_STOCK_MODE` - default stock mode: `instock`, `backorder`, or `outofstock`.
- `WC_CATEGORIES` - semicolon-separated category buttons.
- `WC_PRODUCT_BRANDS` - semicolon-separated product brand buttons.
- `WC_CAR_BRANDS` - semicolon-separated car brand buttons.
- `BOT_ARCHIVE_PAGE_OPTIONS` - semicolon-separated archive page presets.
- `BOT_PRODUCT_LIMIT_OPTIONS` - semicolon-separated product limit presets.

The `WC_CATEGORIES`, `WC_PRODUCT_BRANDS`, and `WC_CAR_BRANDS` values are only initial seed values.
After the bot starts, manage dictionaries in Telegram:

```text
/settings
```

The bot stores runtime dictionaries in:

```text
data/bot-settings.json
```

This file is ignored by git because it is production/user-managed state.

Optional initial example:

```env
WC_CATEGORIES=Uncategorized;Suspension > Copelas regulables;Brakes > Pads
WC_PRODUCT_BRANDS=PMC Motorsport;BMW;Febi
WC_CAR_BRANDS=VAG;BMW;Mercedes-Benz
```

The names should match existing WooCommerce categories/taxonomy terms if you want the import to attach products cleanly.

## Extraction Strategy

The scraper is selector-free by default. It uses:

- JSON-LD/schema.org Product data when available.
- OpenGraph and product meta tags.
- WooCommerce/common product DOM patterns.
- URL and card heuristics to discover product links from archive pages.

Some heavily protected sites may still block browsers or hide prices behind API calls. For those, add site-specific rules later, but the default flow is ready for normal e-commerce archives.
