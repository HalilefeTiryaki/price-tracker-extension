# PriceWatch — Chrome Extension

A professional Manifest V3 Chrome Extension that tracks e-commerce product prices
and size availability, sending desktop notifications when your criteria are met.

---

## Features

- **Dynamic selector engine** — domain-specific CSS selectors with 3-layer fallback:
  1. `selectors.json` domain map (12+ stores pre-configured)
  2. Schema.org JSON-LD structured data
  3. OpenGraph/meta tags + heuristic DOM scanning
- **Session-aware background checks** — fetches with `credentials: include` so
  loyalty discounts and logged-in prices are captured
- **Size & stock tracking** — per-size in-stock/out-of-stock detection
- **Price history** — mini chart + timestamped list, up to 30 data points per product
- **Smart alert modes** — any drop / below target price / size restocked
- **Rich notifications** — click to open the product page instantly
- **Clean popup UI** — slate/teal palette, no CDN dependencies, fully CSP-compliant

---

## File Structure

```
price-tracker/
├── manifest.json       # MV3 config, permissions, CSP
├── background.js       # Service worker: alarms, fetch, parse, notify
├── content.js          # Scraping engine injected into product pages
├── popup.html          # Extension popup markup
├── popup.css           # Native CSS (no frameworks)
├── popup.js            # Popup state management & chart rendering
├── selectors.json      # Domain → CSS selector map
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

### Step 1 — Clone / Download

Download or unzip this folder to a stable location on your machine
(e.g., `~/extensions/price-tracker`). Do **not** move the folder after installing.

### Step 2 — Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `price-tracker` folder
5. The PriceWatch icon (teal circle) appears in your toolbar

### Step 3 — Grant Notifications

The first time an alert fires, Chrome may ask you to allow notifications from
the extension. Click **Allow**.

---

## Usage

### Adding a product

1. Navigate to any product page on a supported store (Amazon, eBay, Zalando,
   ASOS, Nike, Adidas, Uniqlo, Farfetch, H&M, Zara, and more)
2. Click the PriceWatch toolbar icon
3. The popup auto-scrapes the product name, price, and available sizes
4. Optionally select your target size from the dropdown
5. Choose your alert mode:
   - **Any price drop** — notify on any decrease
   - **Below target price** — notify only if price falls under your threshold
   - **Size restocked only** — notify when your size comes back, regardless of price
6. Click **Track this product**

### Managing tracked items

- The **Active tracking** section lists all products with current price, trend
  arrow, and size/stock badge
- Click the clock icon on any item to view its full price history chart
- Click × to remove a product from tracking
- Click the ↺ button in the header to force an immediate check of all products

### Background checks

The extension checks all tracked products **every 20 minutes** automatically,
even when the popup is closed. Chrome must be running.

---

## Adding More Stores

Edit `selectors.json` and add a block for the new domain:

```json
"example-store.com": {
  "name":       "h1.product-name",
  "price":      "span.current-price",
  "image":      "img.product-main-image",
  "sizes":      "ul.size-list button",
  "sizeLabel":  "text",
  "outOfStock": "button.disabled, button[aria-disabled='true']"
}
```

The selector for `sizes` should match **all** size buttons/options (both in-stock
and out-of-stock). The `outOfStock` selector identifies the unavailable ones.
The extension reloads `selectors.json` on every check, so no restart is needed.

---

## Supported Stores (pre-configured)

| Store | Domain |
|---|---|
| Amazon (US/UK/DE) | amazon.com, amazon.co.uk, amazon.de |
| eBay (US/UK) | ebay.com, ebay.co.uk |
| Zalando (DE/UK) | zalando.de, zalando.co.uk |
| ASOS | asos.com |
| Nike | nike.com |
| Adidas | adidas.com |
| Uniqlo | uniqlo.com |
| Farfetch | farfetch.com |
| H&M | hm.com |
| Zara | zara.com |

Unsupported domains fall back to JSON-LD / OpenGraph parsing, which works well
on most modern e-commerce sites.

---

## Architecture Notes

### Why no background iframe / offscreen document?

MV3 service workers have full `fetch()` access with `credentials: include`,
which correctly forwards the user's cookies for the target domain. This gives
us personalized pricing without needing to inject iframes.

### DOMParser in the service worker

`DOMParser` is available in MV3 service workers (Chrome 109+). We parse the
fetched HTML string into a full DOM and run the same selector/fallback chain
used by the content script.

### Storage layout

```
chrome.storage.local:
  trackedProducts: {
    [url]: {
      url, name, image, currency,
      lastPrice, trackedSize, lastSizeInStock,
      targetPrice, alertAnyDrop, alertStockOnly,
      addedAt, lastChecked, sizes[]
    }
  }
  history_{encodedUrl}: [
    { price: number, timestamp: number },
    ...  (max 30 entries)
  ]
```

---

## Permissions Explained

| Permission | Reason |
|---|---|
| `storage` | Save tracked products and price history |
| `notifications` | Desktop alerts for price drops / restocks |
| `alarms` | Periodic background price checks |
| `cookies` | Read session cookies for personalized pricing |
| `activeTab` | Detect the current product page |
| `tabs` | Open product page when notification is clicked |
| `scripting` | Inject content script on demand |
| `<all_urls>` (host) | Fetch any product page in the background |

---

## Troubleshooting

**Popup shows "Navigate to a product page"**
→ The content script may not have loaded yet. Refresh the product page and
  try again.

**Price shows as "—"**
→ The site may use JavaScript-rendered prices (single-page app). The content
  script can read the live DOM, but background fetches get server-rendered HTML.
  Open an issue with the domain name to add a custom selector.

**Notifications not appearing**
→ Check `chrome://settings/content/notifications` and ensure the extension
  is allowed.

**Background checks not running**
→ Service workers are terminated by Chrome when idle. They restart automatically
  when the alarm fires. Check `chrome://extensions` → PriceWatch → Service Worker
  → Inspect to see the console log.
