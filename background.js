/**
 * background.js — PriceWatch Service Worker
 *
 * Responsibilities:
 *   - Set up periodic alarms (every 20 minutes) to re-check tracked products
 *   - Fetch product pages with user's session cookies (credentials: 'include')
 *   - Parse HTML using DOMParser + selectors.json fallback chain
 *   - Compare new price/stock status against stored data
 *   - Dispatch rich desktop notifications when alert conditions are met
 *   - Update price history in chrome.storage.local
 *
 * This is a Manifest V3 Service Worker — stateless between activations.
 * All persistent state lives in chrome.storage.local.
 */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────

const ALARM_NAME        = 'pricewatch-check';
const ALARM_INTERVAL    = 20; // minutes
const MAX_HISTORY       = 30; // max price history points per product
const SELECTORS_URL     = chrome.runtime.getURL('selectors.json');

// ─── Startup & Alarm Setup ───────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[PriceWatch BG] Extension installed/updated.');
  await setupAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[PriceWatch BG] Browser started.');
  await setupAlarm();
});

async function setupAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,          // First check after 1 minute
      periodInMinutes: ALARM_INTERVAL
    });
    console.log(`[PriceWatch BG] Alarm set: every ${ALARM_INTERVAL} minutes.`);
  }
}

// ─── Alarm Handler ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log('[PriceWatch BG] Alarm fired — checking tracked products.');
  await checkAllProducts();
});

// ─── Notification Click Handler ───────────────────────────────────────────────

chrome.notifications.onClicked.addListener(async (notificationId) => {
  // notificationId is the product URL
  if (notificationId.startsWith('http')) {
    await chrome.tabs.create({ url: notificationId, active: true });
    chrome.notifications.clear(notificationId);
  }
});

// ─── Message Listener (from popup) ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FORCE_CHECK') {
    checkAllProducts()
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.type === 'CHECK_SINGLE') {
    checkSingleProduct(message.url)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── Core Check Orchestrator ──────────────────────────────────────────────────

async function checkAllProducts() {
  const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
  const urls = Object.keys(trackedProducts);

  if (urls.length === 0) {
    console.log('[PriceWatch BG] No products to check.');
    return;
  }

  // Load selectors.json once for the whole batch
  const selectorMap = await loadSelectorMap();

  for (const url of urls) {
    try {
      await checkSingleProduct(url, trackedProducts[url], selectorMap);
      // Polite delay between requests to avoid rate limiting
      await sleep(2500 + Math.random() * 2000);
    } catch (err) {
      console.warn(`[PriceWatch BG] Failed to check ${url}:`, err.message);
    }
  }
}

async function checkSingleProduct(url, productData = null, selectorMap = null) {
  // Load stored data if not passed in
  if (!productData) {
    const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
    productData = trackedProducts[url];
  }
  if (!productData) {
    console.warn(`[PriceWatch BG] No data for URL: ${url}`);
    return null;
  }

  if (!selectorMap) {
    selectorMap = await loadSelectorMap();
  }

  // ── Fetch the product page ─────────────────────────────────────────────────
  const html = await fetchProductPage(url);
  if (!html) {
    console.warn(`[PriceWatch BG] Could not fetch: ${url}`);
    return null;
  }

  // ── Parse the HTML ─────────────────────────────────────────────────────────
  const domain = extractDomain(url);
  const selConfig = selectorMap[domain] || null;
  const parsed = parseProductHtml(html, selConfig, url);

  if (!parsed) {
    console.warn(`[PriceWatch BG] Could not parse product data from: ${url}`);
    return null;
  }

  const now = Date.now();
  const prevPrice     = productData.lastPrice;
  const newPrice      = parsed.price;
  const targetPrice   = productData.targetPrice;
  const alertAnyDrop  = productData.alertAnyDrop;
  const trackedSize   = productData.trackedSize;

  // ── Update price history ───────────────────────────────────────────────────
  const historyKey = `history_${encodeKey(url)}`;
  const stored = await chrome.storage.local.get(historyKey);
  const history = stored[historyKey] || [];

  if (newPrice !== null) {
    history.push({ price: newPrice, timestamp: now });
    // Trim to max history length
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await chrome.storage.local.set({ [historyKey]: history });
  }

  // ── Check size availability ────────────────────────────────────────────────
  let sizeRestocked = false;
  let currentSizeInStock = false;

  if (trackedSize && parsed.sizes && parsed.sizes.length > 0) {
    const sizeObj = parsed.sizes.find(
      s => s.label.trim().toLowerCase() === trackedSize.trim().toLowerCase()
    );
    if (sizeObj) {
      currentSizeInStock = sizeObj.inStock;
      const wasInStock = productData.lastSizeInStock;
      if (currentSizeInStock && wasInStock === false) {
        sizeRestocked = true; // was OOS, now in stock
      }
    }
  }

  // ── Evaluate alert conditions ──────────────────────────────────────────────
  let shouldAlert = false;
  let alertMessage = '';

  const priceDropped = newPrice !== null && prevPrice !== null && newPrice < prevPrice;
  const belowTarget  = newPrice !== null && targetPrice !== null && newPrice <= targetPrice;

  if (sizeRestocked) {
    shouldAlert = true;
    const priceStr = formatPrice(newPrice, productData.currency);
    alertMessage = trackedSize
      ? `Size ${trackedSize} is back in stock at ${priceStr}!`
      : `Back in stock at ${priceStr}!`;
  } else if (alertAnyDrop && priceDropped) {
    shouldAlert = true;
    alertMessage = `Price dropped to ${formatPrice(newPrice, productData.currency)} (was ${formatPrice(prevPrice, productData.currency)})`;
  } else if (!alertAnyDrop && belowTarget && priceDropped) {
    shouldAlert = true;
    alertMessage = `Price dropped to ${formatPrice(newPrice, productData.currency)} — below your target of ${formatPrice(targetPrice, productData.currency)}!`;
  }

  // ── Fire notification ──────────────────────────────────────────────────────
  if (shouldAlert) {
    await fireNotification(url, productData.name || parsed.name, alertMessage, parsed.image);
  }

  // ── Persist updated product state ──────────────────────────────────────────
  const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
  trackedProducts[url] = {
    ...productData,
    lastPrice:       newPrice ?? productData.lastPrice,
    lastChecked:     now,
    lastSizeInStock: trackedSize ? currentSizeInStock : undefined,
    image:           parsed.image || productData.image,
    sizes:           parsed.sizes || productData.sizes
  };
  await chrome.storage.local.set({ trackedProducts });

  console.log(`[PriceWatch BG] Checked: ${productData.name || url} | Price: ${newPrice} | Alert: ${shouldAlert}`);
  return { newPrice, sizeRestocked, shouldAlert, alertMessage };
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

/**
 * Fetch a product page, passing the user's cookies for that domain.
 * Uses credentials: 'include' so session/loyalty discounts are visible.
 */
async function fetchProductPage(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        // Mimic a real browser to avoid bot detection
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': navigator.userAgent
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000) // 20-second timeout
    });

    if (!response.ok) {
      console.warn(`[PriceWatch BG] HTTP ${response.status} for ${url}`);
      return null;
    }

    return await response.text();
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.warn(`[PriceWatch BG] Timeout fetching ${url}`);
    } else {
      console.warn(`[PriceWatch BG] Fetch error for ${url}:`, err.message);
    }
    return null;
  }
}

// ─── HTML Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a raw HTML string to extract product data.
 * Uses the same fallback chain as content.js but runs inside the service worker.
 */
function parseProductHtml(html, selConfig, originalUrl) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let result = null;

    // Layer 1: Domain selectors
    if (selConfig) {
      result = extractWithSelectors(doc, selConfig);
    }

    // Layer 2: JSON-LD
    if (!result || !result.name) {
      const jsonLd = extractFromJsonLd(doc);
      if (jsonLd) {
        result = result ? mergeResults(jsonLd, result) : jsonLd;
      }
    }

    // Layer 3: Meta tags
    if (!result || !result.name) {
      const meta = extractFromMeta(doc);
      if (meta) {
        result = result ? mergeResults(meta, result) : meta;
      }
    }

    // Layer 4: Heuristic
    if (!result) {
      result = extractHeuristic(doc);
    }

    // Enrich sizes if needed
    if (result && (!result.sizes || result.sizes.length === 0) && selConfig) {
      result.sizes = extractSizes(doc, selConfig);
    }

    return result;
  } catch (err) {
    console.error('[PriceWatch BG] DOMParser error:', err.message);
    return null;
  }
}

/** Merge two result objects, preferring values from `override` when defined */
function mergeResults(base, override) {
  const merged = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== null && v !== undefined) merged[k] = v;
  }
  return merged;
}

// ── Extraction helpers (mirror of content.js, operating on a parsed document) ─

function extractWithSelectors(doc, selConfig) {
  const name = queryText(doc, selConfig.name);
  const rawPrice = queryText(doc, selConfig.price);
  const image = queryImageSrc(doc, selConfig.image);
  const price = parsePrice(rawPrice);
  const sizes = extractSizes(doc, selConfig);

  if (!name && !price) return null;
  return { source: 'selectors', name, price, currency: detectCurrency(rawPrice) || 'USD', image, sizes };
}

function extractFromJsonLd(doc) {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if ((item['@type'] || '').toLowerCase() !== 'product') continue;
        let price = null, currency = 'USD', sizes = [];
        const offers = item.offers;
        if (offers) {
          const list = Array.isArray(offers) ? offers : [offers];
          const first = list.find(o => o.price || o.lowPrice);
          if (first) {
            price = parseFloat(first.price || first.lowPrice);
            currency = first.priceCurrency || currency;
          }
          sizes = list
            .filter(o => o.availability && o.itemOffered?.size)
            .map(o => ({
              label: String(o.itemOffered.size),
              inStock: o.availability.toLowerCase().includes('instock')
            }));
        }
        return {
          source: 'json-ld',
          name: item.name || null,
          price,
          currency,
          image: item.image ? (Array.isArray(item.image) ? item.image[0] : item.image) : null,
          sizes
        };
      }
    } catch (_) {}
  }
  return null;
}

function extractFromMeta(doc) {
  function meta(prop) {
    const el = doc.querySelector(`meta[property="${prop}"]`) || doc.querySelector(`meta[name="${prop}"]`);
    return el ? el.getAttribute('content') : null;
  }
  const name = meta('og:title') || meta('twitter:title') || doc.title || null;
  const rawPrice = meta('og:price:amount') || meta('product:price:amount') || null;
  const image = meta('og:image') || meta('twitter:image') || null;
  if (!rawPrice && !name) return null;
  return {
    source: 'meta',
    name,
    price: parsePrice(rawPrice),
    currency: meta('og:price:currency') || meta('product:price:currency') || 'USD',
    image,
    sizes: []
  };
}

function extractHeuristic(doc) {
  const nameEl = doc.querySelector('h1[itemprop="name"]') || doc.querySelector('[itemprop="name"]') || doc.querySelector('h1');
  const priceEl = doc.querySelector('[itemprop="price"]') || doc.querySelector('[class*="price"]:not([class*="was"])');
  const rawPrice = priceEl ? (priceEl.getAttribute('content') || priceEl.textContent) : null;
  const imageEl = doc.querySelector('[itemprop="image"]') || doc.querySelector('img[class*="product"]');
  return {
    source: 'heuristic',
    name: nameEl ? nameEl.textContent.trim() : doc.title,
    price: parsePrice(rawPrice),
    currency: 'USD',
    image: imageEl ? imageEl.src : null,
    sizes: []
  };
}

function extractSizes(doc, selConfig) {
  if (!selConfig?.sizes) return [];
  const elements = Array.from(doc.querySelectorAll(selConfig.sizes));
  return elements.map(el => {
    const label = el.textContent.trim();
    if (!label || label.toLowerCase().includes('select') || label === '-') return null;
    const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled');
    const hasOosClass = /out.?of.?stock|sold.?out|unavailable/i.test(el.className || '');
    const matchesOos = selConfig.outOfStock && el.matches && el.matches(selConfig.outOfStock);
    return { label, inStock: !isDisabled && !hasOosClass && !matchesOos };
  }).filter(Boolean);
}

// ─── Shared Parsing Utilities ─────────────────────────────────────────────────

function queryText(doc, selector) {
  if (!selector) return null;
  // Try each selector in comma-separated list for robustness
  const parts = selector.split(',').map(s => s.trim());
  for (const s of parts) {
    const el = doc.querySelector(s);
    if (el) {
      const text = el.getAttribute('content') || el.textContent.trim();
      if (text) return text;
    }
  }
  return null;
}

function queryImageSrc(doc, selector) {
  if (!selector) return null;
  const parts = selector.split(',').map(s => s.trim());
  for (const s of parts) {
    const el = doc.querySelector(s);
    if (el) return el.src || el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || null;
  }
  return null;
}

function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return null;

  // Case 1: European format — comma is decimal separator
  // e.g. "949,00" or "1.399,00" → 949.00 or 1399.00
  if (/,\d{2}$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }

  // Case 2: US format — dot is decimal separator, commas are thousands
  // e.g. "1,399.00" → 1399.00
  if (/\.\d{2}$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/,/g, ''));
  }

  // Case 3: No decimals, commas are thousands separators
  // e.g. "1,399" → 1399
  if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
    return parseFloat(cleaned.replace(/,/g, ''));
  }

  // Fallback: strip all commas
  return parseFloat(cleaned.replace(/,/g, ''));
}

function detectCurrency(rawPrice) {
  if (!rawPrice) return null;
  const s = rawPrice;

  if (s.includes('₺') || s.includes('TL') || s.includes('TRY')) return 'TRY';
  if (s.includes('€') || s.includes('EUR'))                      return 'EUR';
  if (s.includes('£') || s.includes('GBP'))                      return 'GBP';
  if (s.includes('¥') || s.includes('JPY'))                      return 'JPY';
  if (s.includes('₩') || s.includes('KRW'))                      return 'KRW';
  if (s.includes('₹') || s.includes('INR'))                      return 'INR';
  if (s.includes('₽') || s.includes('RUB'))                      return 'RUB';
  if (s.includes('฿') || s.includes('THB'))                      return 'THB';
  if (s.includes('₴') || s.includes('UAH'))                      return 'UAH';
  if (s.includes('₦') || s.includes('NGN'))                      return 'NGN';
  if (s.includes('₫') || s.includes('VND'))                      return 'VND';
  if (s.includes('R$') || s.includes('BRL'))                     return 'BRL';
  if (s.includes('C$') || s.includes('CAD'))                     return 'CAD';
  if (s.includes('A$') || s.includes('AUD'))                     return 'AUD';
  if (s.includes('HK$') || s.includes('HKD'))                    return 'HKD';
  if (s.includes('S$') || s.includes('SGD'))                     return 'SGD';
  if (s.includes('MX$') || s.includes('MXN'))                    return 'MXN';
  if (s.includes('zł') || s.includes('PLN'))                     return 'PLN';
  if (s.includes('Kč') || s.includes('CZK'))                     return 'CZK';
  if (s.includes('Ft') || s.includes('HUF'))                     return 'HUF';
  if (s.includes('lei') || s.includes('RON'))                    return 'RON';
  if (s.includes('лв') || s.includes('BGN'))                     return 'BGN';
  if (s.includes('kn') || s.includes('HRK'))                     return 'HRK';
  if (s.includes('CHF'))                                         return 'CHF';
  if (s.includes('ر.س') || s.includes('SAR'))                    return 'SAR';
  if (s.includes('د.إ') || s.includes('AED'))                    return 'AED';
  if (s.includes('NZ$') || s.includes('NZD'))                    return 'NZD';
  if (s.includes('DKK'))                                         return 'DKK';
  if (s.includes('NOK'))                                         return 'NOK';
  if (s.includes('SEK'))                                         return 'SEK';
  if (s.includes('kr'))                                          return 'SEK';
  if (s.includes('$') || s.includes('USD'))                      return 'USD';

  return null;
}

function formatPrice(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return 'N/A';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount}`;
  }
}

// ─── Notification System ──────────────────────────────────────────────────────

async function fireNotification(url, productName, message, iconUrl) {
  const notifId = url; // Use URL as ID so clicking it opens the product

  const options = {
    type: 'basic',
    iconUrl: iconUrl || 'icons/icon128.png',
    title: `📉 PriceWatch: ${productName || 'Product Alert'}`,
    message,
    priority: 2,
    requireInteraction: true // Keep notification visible until clicked
  };

  try {
    await chrome.notifications.create(notifId, options);
    console.log(`[PriceWatch BG] Notification fired: ${message}`);
  } catch (err) {
    console.error('[PriceWatch BG] Notification error:', err.message);
  }
}

// ─── Selector Map Loading ─────────────────────────────────────────────────────

async function loadSelectorMap() {
  try {
    const response = await fetch(SELECTORS_URL);
    const data = await response.json();
    return data;
  } catch (err) {
    console.warn('[PriceWatch BG] Could not load selectors.json:', err.message);
    return {};
  }
}

// ─── Misc Utilities ───────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

function encodeKey(url) {
  // Simple sanitization for use as a storage key suffix
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
