/**
 * content.js — PriceWatch Scraping Engine
 *
 * Injected into product pages to extract:
 *   - Product name, image, current price
 *   - Available sizes and their stock status
 *
 * Fallback chain:
 *   1. Domain-specific selectors from selectors.json (via message from popup)
 *   2. Schema.org JSON-LD structured data
 *   3. OpenGraph / meta tags
 *   4. Heuristic DOM scanning
 */

(() => {
  'use strict';

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Attempt to parse a price string into a float.
   * Handles formats like "$12,345.67", "€1.234,56", "12 345,67 kr"
   */
  function parsePrice(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/[^\d.,]/g, '').trim();
    if (!cleaned) return null;

    // European format: comma = decimal separator (e.g. "949,00" or "1.399,00")
    if (/,\d{2}$/.test(cleaned)) {
      return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    }

    // US format: dot = decimal separator (e.g. "1,399.00")
    if (/\.\d{2}$/.test(cleaned)) {
      return parseFloat(cleaned.replace(/,/g, ''));
    }

    // Thousands-only commas (e.g. "1,399")
    if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
      return parseFloat(cleaned.replace(/,/g, ''));
    }

    return parseFloat(cleaned.replace(/,/g, ''));
  }

  /**
   * Get text content of the first matching element.
   */
  function queryText(selector, root = document) {
    if (!selector) return null;
    const el = root.querySelector(selector);
    return el ? el.textContent.trim() : null;
  }

  /**
   * Get the src of the first matching image.
   */
  function queryImageSrc(selector, root = document) {
    if (!selector) return null;
    const el = root.querySelector(selector);
    if (!el) return null;
    return el.src || el.dataset.src || el.getAttribute('data-lazy-src') || null;
  }

  // ─── Fallback Layer 1: JSON-LD Schema.org ─────────────────────────────────

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          const type = (item['@type'] || '').toLowerCase();
          if (type !== 'product') continue;

          let price = null;
          let currency = 'USD';
          let sizes = [];

          // Price from offers
          const offers = item.offers;
          if (offers) {
            const offerList = Array.isArray(offers) ? offers : [offers];
            const firstValid = offerList.find(o => o.price || o.lowPrice);
            if (firstValid) {
              price = parseFloat(firstValid.price || firstValid.lowPrice);
              currency = firstValid.priceCurrency || currency;
            }

            // Sizes from offers with size variant
            sizes = offerList
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
            image: item.image
              ? (Array.isArray(item.image) ? item.image[0] : item.image)
              : null,
            sizes
          };
        }
      } catch (_) {
        // Malformed JSON-LD — skip
      }
    }
    return null;
  }

  // ─── Fallback Layer 2: OpenGraph / Meta Tags ───────────────────────────────

  function extractFromMeta() {
    function meta(property) {
      const el =
        document.querySelector(`meta[property="${property}"]`) ||
        document.querySelector(`meta[name="${property}"]`);
      return el ? el.getAttribute('content') : null;
    }

    const name =
      meta('og:title') ||
      meta('twitter:title') ||
      document.title ||
      null;

    const rawPrice =
      meta('og:price:amount') ||
      meta('product:price:amount') ||
      meta('twitter:data1');

    const image =
      meta('og:image') ||
      meta('twitter:image') ||
      null;

    if (!rawPrice && !name) return null;

    return {
      source: 'meta',
      name,
      price: parsePrice(rawPrice),
      currency: meta('og:price:currency') || meta('product:price:currency') || 'USD',
      image,
      sizes: [] // Meta tags rarely encode sizes
    };
  }

  // ─── Fallback Layer 3: Heuristic DOM scan ─────────────────────────────────

  function extractHeuristic() {
    // Common heading patterns for product names
    const nameEl =
      document.querySelector('h1[itemprop="name"]') ||
      document.querySelector('[itemprop="name"]') ||
      document.querySelector('h1');

    // Common price patterns
    const priceEl =
      document.querySelector('[itemprop="price"]') ||
      document.querySelector('[class*="price"]:not([class*="was"]):not([class*="old"])') ||
      document.querySelector('[data-price]');

    const rawPrice = priceEl
      ? (priceEl.getAttribute('content') ||
         priceEl.getAttribute('data-price') ||
         priceEl.textContent)
      : null;

    const imageEl =
      document.querySelector('[itemprop="image"]') ||
      document.querySelector('.product img, #product img, .pdp img') ||
      document.querySelector('img[class*="product"]');

    return {
      source: 'heuristic',
      name: nameEl ? nameEl.textContent.trim() : document.title,
      price: parsePrice(rawPrice),
      currency: 'USD',
      image: imageEl ? imageEl.src : null,
      sizes: []
    };
  }

  // ─── Size Extraction ───────────────────────────────────────────────────────

  /**
   * Given a selectorConfig for the current domain, extract size buttons/options.
   * Determines stock status by checking:
   *   - disabled attribute
   *   - aria-disabled attribute
   *   - class names containing out-of-stock patterns
   *   - visibility / pointer events (basic check)
   */
  function extractSizes(selectorConfig) {
    if (!selectorConfig?.sizes) return [];

    const elements = Array.from(
      document.querySelectorAll(selectorConfig.sizes)
    );

    const outOfStockSelector = selectorConfig.outOfStock;

    return elements
      .map(el => {
        // Get label text
        let label = '';
        if (selectorConfig.sizeLabel === 'button') {
          label = (el.querySelector('button') || el).textContent.trim();
        } else {
          label = el.textContent.trim();
        }

        // Skip empty or "select size" placeholder options
        if (!label || label.toLowerCase().includes('select') || label === '-') {
          return null;
        }

        // Determine stock status
        const isDisabled =
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('disabled');

        const classNames = el.className || '';
        const hasOosClass =
          /out.?of.?stock|sold.?out|unavailable|oos/i.test(classNames);

        const matchesOosSelector =
          outOfStockSelector && el.matches(outOfStockSelector);

        const inStock = !isDisabled && !hasOosClass && !matchesOosSelector;

        return { label, inStock };
      })
      .filter(Boolean);
  }

  // ─── Primary Extraction with Domain Selectors ──────────────────────────────

  function extractWithSelectors(selectorConfig) {
    const name = queryText(selectorConfig.name);
    const rawPrice = queryText(selectorConfig.price);
    const image = queryImageSrc(selectorConfig.image);
    const price = parsePrice(rawPrice);
    const sizes = extractSizes(selectorConfig);

    if (!name && !price) return null;

    return {
      source: 'selectors',
      name,
      price,
      currency: detectCurrency(rawPrice) || 'USD',
      image,
      sizes
    };
  }

  function detectCurrency(rawPrice) {
    if (!rawPrice) return null;
    const s = rawPrice;

    // Symbol-based detection (most reliable — order matters for ambiguous symbols)
    if (s.includes('₺') || s.includes('TL') || s.includes('TRY')) return 'TRY'; // Turkish Lira
    if (s.includes('€') || s.includes('EUR'))                      return 'EUR'; // Euro
    if (s.includes('£') || s.includes('GBP'))                      return 'GBP'; // British Pound
    if (s.includes('¥') || s.includes('JPY'))                      return 'JPY'; // Japanese Yen
    if (s.includes('₩') || s.includes('KRW'))                      return 'KRW'; // South Korean Won
    if (s.includes('₹') || s.includes('INR'))                      return 'INR'; // Indian Rupee
    if (s.includes('₽') || s.includes('RUB'))                      return 'RUB'; // Russian Ruble
    if (s.includes('฿') || s.includes('THB'))                      return 'THB'; // Thai Baht
    if (s.includes('₴') || s.includes('UAH'))                      return 'UAH'; // Ukrainian Hryvnia
    if (s.includes('₦') || s.includes('NGN'))                      return 'NGN'; // Nigerian Naira
    if (s.includes('₫') || s.includes('VND'))                      return 'VND'; // Vietnamese Dong
    if (s.includes('R$') || s.includes('BRL'))                     return 'BRL'; // Brazilian Real
    if (s.includes('C$') || s.includes('CAD'))                     return 'CAD'; // Canadian Dollar
    if (s.includes('A$') || s.includes('AUD'))                     return 'AUD'; // Australian Dollar
    if (s.includes('HK$') || s.includes('HKD'))                    return 'HKD'; // Hong Kong Dollar
    if (s.includes('S$') || s.includes('SGD'))                     return 'SGD'; // Singapore Dollar
    if (s.includes('MX$') || s.includes('MXN'))                    return 'MXN'; // Mexican Peso
    if (s.includes('zł') || s.includes('PLN'))                     return 'PLN'; // Polish Zloty
    if (s.includes('Kč') || s.includes('CZK'))                     return 'CZK'; // Czech Koruna
    if (s.includes('Ft') || s.includes('HUF'))                     return 'HUF'; // Hungarian Forint
    if (s.includes('lei') || s.includes('RON'))                    return 'RON'; // Romanian Leu
    if (s.includes('лв') || s.includes('BGN'))                     return 'BGN'; // Bulgarian Lev
    if (s.includes('kn') || s.includes('HRK'))                     return 'HRK'; // Croatian Kuna
    if (s.includes('CHF'))                                         return 'CHF'; // Swiss Franc
    if (s.includes('دج') || s.includes('DZD'))                     return 'DZD'; // Algerian Dinar
    if (s.includes('ر.س') || s.includes('SAR'))                    return 'SAR'; // Saudi Riyal
    if (s.includes('د.إ') || s.includes('AED'))                    return 'AED'; // UAE Dirham
    if (s.includes('﷼') || s.includes('IRR'))                      return 'IRR'; // Iranian Rial
    if (s.includes('NZ$') || s.includes('NZD'))                    return 'NZD'; // New Zealand Dollar
    if (s.includes('R') && /\bR\s*\d/.test(s))                     return 'ZAR'; // South African Rand
    // Scandinavian crowns (check after TRY since "kr" is ambiguous)
    if (s.includes('DKK'))                                         return 'DKK'; // Danish Krone
    if (s.includes('NOK'))                                         return 'NOK'; // Norwegian Krone
    if (s.includes('SEK'))                                         return 'SEK'; // Swedish Krona
    if (s.includes('kr'))                                          return 'SEK'; // Default kr → SEK
    // Dollar sign last — most ambiguous
    if (s.includes('$') || s.includes('USD'))                      return 'USD'; // US Dollar

    return null; // Unknown — let JSON-LD/meta tags provide the currency instead
  }

  // ─── Main Orchestrator ─────────────────────────────────────────────────────

  /**
   * Run the full extraction pipeline with graceful fallbacks.
   * Returns the best result found.
   */
  function extractProductData(selectorConfig = null) {
    let result = null;

    // Layer 1: Domain-specific selectors (most precise)
    if (selectorConfig) {
      result = extractWithSelectors(selectorConfig);
    }

    // Layer 2: JSON-LD structured data
    // Trigger this layer whenever name OR price is still missing, not just name —
    // a domain selector can correctly find the title but miss the price (e.g. site
    // redesign changed the price markup), and we want JSON-LD to fill that gap.
    if (!result || !result.name || result.price == null) {
      const jsonLd = extractFromJsonLd();
      if (jsonLd) {
        result = result
          ? { ...jsonLd, ...filterDefined(result) }
          : jsonLd;
      }
    }

    // Layer 3: OpenGraph meta tags
    if (!result || !result.name || result.price == null) {
      const meta = extractFromMeta();
      if (meta) {
        result = result
          ? { ...meta, ...filterDefined(result) }
          : meta;
      }
    }

    // Layer 4: Heuristic DOM scanning (last resort)
    if (!result) {
      result = extractHeuristic();
    }

    // Enrich sizes if JSON-LD provided them but selector layer didn't
    if (result && (!result.sizes || result.sizes.length === 0) && selectorConfig) {
      result.sizes = extractSizes(selectorConfig);
    }

    return {
      ...result,
      url: window.location.href,
      domain: window.location.hostname.replace('www.', ''),
      extractedAt: Date.now()
    };
  }

  /** Return an object with only defined (non-null/undefined) values */
  function filterDefined(obj) {
    return Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    );
  }

  // ─── Message Listener ──────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'EXTRACT_PRODUCT') {
      try {
        const data = extractProductData(message.selectorConfig || null);
        sendResponse({ success: true, data });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return true; // Keep channel open for async
    }

    if (message.type === 'PING') {
      sendResponse({ alive: true });
      return false;
    }
  });

  console.log('[PriceWatch] Content script ready on', window.location.hostname);
})();
