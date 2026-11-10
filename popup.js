/**
 * popup.js — PriceWatch Popup Controller
 *
 * Responsibilities:
 *   - On open: detect current tab's domain, send EXTRACT_PRODUCT to content.js
 *   - Populate the "Track this page" form with scraped data
 *   - Read/write tracked products and price history from chrome.storage.local
 *   - Render the active tracking list with price trends
 *   - Show a price history chart/list in a modal
 *   - Trigger background force-check
 */

'use strict';

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const statusBanner    = $('statusBanner');
const productPreview  = $('productPreview');
const noProduct       = $('noProduct');
const previewImg      = $('previewImg');
const previewName     = $('previewName');
const previewPrice    = $('previewPrice');
const sizeField       = $('sizeField');
const sizeSelect      = $('sizeSelect');
const alertField      = $('alertField');
const targetPriceField = $('targetPriceField');
const targetPriceInput = $('targetPrice');
const currencySymbol  = $('currencySymbol');
const trackBtn        = $('trackBtn');
const refreshBtn      = $('refreshBtn');
const itemList        = $('itemList');
const itemCount       = $('itemCount');
const emptyList       = $('emptyList');
const historyOverlay  = $('historyOverlay');
const historyTitle    = $('historyTitle');
const historyChart    = $('historyChart');
const historyList     = $('historyList');
const closeHistory    = $('closeHistory');

// ─── State ────────────────────────────────────────────────────────────────────

let currentProduct = null; // Scraped from active tab
let currentTab     = null; // chrome.tabs.Tab object
let selectorMap    = {};   // Loaded from selectors.json

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSelectorMap();
  await detectCurrentTab();
  await renderTrackedList();
  bindEvents();
});

// ─── Load Selectors ───────────────────────────────────────────────────────────

async function loadSelectorMap() {
  try {
    const url = chrome.runtime.getURL('selectors.json');
    const res = await fetch(url);
    selectorMap = await res.json();
  } catch (err) {
    console.warn('[PriceWatch Popup] Could not load selectors.json:', err.message);
  }
}

// ─── Tab Detection & Scraping ─────────────────────────────────────────────────

async function detectCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    if (!tab?.url?.startsWith('http')) {
      showNoProduct();
      return;
    }

    const domain = extractDomain(tab.url);
    const selConfig = selectorMap[domain] || null;

    // Send EXTRACT_PRODUCT message to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_PRODUCT',
      selectorConfig: selConfig
    }).catch(() => null);

    if (!response?.success || !response.data) {
      showNoProduct();
      return;
    }

    currentProduct = response.data;
    populateAddForm(currentProduct);

  } catch (err) {
    console.warn('[PriceWatch Popup] Tab detection error:', err.message);
    showNoProduct();
  }
}

function showNoProduct() {
  noProduct.hidden = false;
  productPreview.hidden = true;
  sizeField.hidden = true;
  alertField.hidden = true;
  targetPriceField.hidden = true;
  trackBtn.hidden = true;
}

function populateAddForm(product) {
  // Preview
  previewName.textContent = truncate(product.name || 'Unknown product', 55);
  previewPrice.textContent = product.price !== null
    ? formatPrice(product.price, product.currency)
    : 'Price unavailable';

  if (product.image) {
    previewImg.src = product.image;
    previewImg.onerror = () => { previewImg.src = ''; previewImg.style.background = '#e2e8f0'; };
  } else {
    previewImg.style.background = '#e2e8f0';
  }

  productPreview.hidden = false;
  noProduct.hidden = true;
  alertField.hidden = false;
  trackBtn.hidden = false;

  // Populate size dropdown
  sizeSelect.innerHTML = '<option value="">— Any / not tracking size —</option>';
  if (product.sizes && product.sizes.length > 0) {
    sizeField.hidden = false;
    for (const size of product.sizes) {
      const opt = document.createElement('option');
      opt.value = size.label;
      opt.textContent = size.inStock
        ? size.label
        : `${size.label} (out of stock)`;
      opt.disabled = false; // User can still track OOS sizes
      sizeSelect.appendChild(opt);
    }
  }

  // Currency symbol
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', SEK: 'kr ' };
  currencySymbol.textContent = symbols[product.currency] || '$';
}

// ─── Alert Mode Toggling ──────────────────────────────────────────────────────

function bindEvents() {
  // Radio toggle for alert mode
  document.querySelectorAll('input[name="alertMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      targetPriceField.hidden = radio.value !== 'targetPrice';
    });
  });

  // Track button
  trackBtn.addEventListener('click', handleTrack);

  // Refresh button
  refreshBtn.addEventListener('click', handleRefresh);

  // Close history modal
  closeHistory.addEventListener('click', () => {
    historyOverlay.hidden = true;
  });

  historyOverlay.addEventListener('click', e => {
    if (e.target === historyOverlay) historyOverlay.hidden = true;
  });

  // Keyboard accessibility
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') historyOverlay.hidden = true;
  });
}

// ─── Track Handler ─────────────────────────────────────────────────────────────

async function handleTrack() {
  if (!currentProduct || !currentTab?.url) return;

  const url = currentTab.url;
  const alertMode = document.querySelector('input[name="alertMode"]:checked')?.value || 'anyDrop';
  const trackedSize = sizeSelect.value || null;

  let targetPrice = null;
  if (alertMode === 'targetPrice') {
    const raw = parseFloat(targetPriceInput.value);
    if (isNaN(raw) || raw <= 0) {
      showBanner('Please enter a valid target price.', 'error');
      targetPriceInput.focus();
      return;
    }
    targetPrice = raw;
  }

  // Check if already tracked
  const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
  if (trackedProducts[url]) {
    showBanner('This product is already being tracked.', 'info');
    return;
  }

  // Find stock status of selected size
  let lastSizeInStock = undefined;
  if (trackedSize && currentProduct.sizes) {
    const sizeObj = currentProduct.sizes.find(s => s.label === trackedSize);
    if (sizeObj) lastSizeInStock = sizeObj.inStock;
  }

  const productEntry = {
    url,
    name:            truncate(currentProduct.name || 'Unknown product', 80),
    image:           currentProduct.image || null,
    currency:        currentProduct.currency || 'USD',
    lastPrice:       currentProduct.price,
    trackedSize,
    lastSizeInStock,
    targetPrice,
    alertAnyDrop:    alertMode === 'anyDrop',
    alertStockOnly:  alertMode === 'stockOnly',
    addedAt:         Date.now(),
    lastChecked:     Date.now(),
    sizes:           currentProduct.sizes || []
  };

  trackedProducts[url] = productEntry;
  await chrome.storage.local.set({ trackedProducts });

  // Seed price history with current price
  if (currentProduct.price !== null) {
    const historyKey = `history_${encodeKey(url)}`;
    await chrome.storage.local.set({
      [historyKey]: [{ price: currentProduct.price, timestamp: Date.now() }]
    });
  }

  showBanner('✓ Now tracking this product!', 'success');
  trackBtn.disabled = true;
  trackBtn.textContent = 'Tracking ✓';

  await renderTrackedList();
}

// ─── Refresh Handler ──────────────────────────────────────────────────────────

async function handleRefresh() {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: 'FORCE_CHECK' });
    showBanner('Checking all prices…', 'info');
    // Re-render after a short delay to pick up updated storage
    setTimeout(async () => {
      await renderTrackedList();
      showBanner('Price check complete.', 'success');
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }, 3000);
  } catch {
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
    showBanner('Could not reach background worker.', 'error');
  }
}

// ─── Tracked List Renderer ────────────────────────────────────────────────────

async function renderTrackedList() {
  const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
  const entries = Object.values(trackedProducts);

  itemCount.textContent = entries.length;

  if (entries.length === 0) {
    emptyList.hidden = false;
    itemList.innerHTML = '';
    return;
  }

  emptyList.hidden = true;
  itemList.innerHTML = '';

  // Sort: most recently added first
  entries.sort((a, b) => b.addedAt - a.addedAt);

  for (const product of entries) {
    const li = buildItemElement(product);
    itemList.appendChild(li);
  }
}

function buildItemElement(product) {
  const li = document.createElement('li');
  li.className = 'pw-item';
  li.dataset.url = product.url;

  // ── Image
  const imgEl = document.createElement('img');
  imgEl.className = 'pw-item-img';
  imgEl.src = product.image || '';
  imgEl.alt = product.name || 'Product';
  imgEl.onerror = () => { imgEl.src = ''; imgEl.style.background = '#e2e8f0'; };

  // ── Body
  const body = document.createElement('div');
  body.className = 'pw-item-body';

  // Name link
  const nameEl = document.createElement('a');
  nameEl.className = 'pw-item-name';
  nameEl.href = '#';
  nameEl.textContent = product.name || 'Unknown product';
  nameEl.title = product.name || '';
  nameEl.addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: product.url, active: true });
  });

  // Meta row (price + trend)
  const meta = document.createElement('div');
  meta.className = 'pw-item-meta';

  const priceEl = document.createElement('span');
  priceEl.className = 'pw-item-price';
  priceEl.textContent = product.lastPrice !== null
    ? formatPrice(product.lastPrice, product.currency)
    : '—';

  meta.appendChild(priceEl);

  // Price trend (calculated from last 2 history entries)
  appendPriceTrend(meta, product);

  // Size pill
  if (product.trackedSize) {
    const sizePill = document.createElement('span');
    sizePill.className = 'pw-pill size';
    sizePill.textContent = product.trackedSize;
    meta.appendChild(sizePill);
  }

  // Stock status pill for tracked size
  if (product.trackedSize && product.lastSizeInStock !== undefined) {
    const stockPill = document.createElement('span');
    stockPill.className = product.lastSizeInStock
      ? 'pw-pill in-stock'
      : 'pw-pill out-stock';
    stockPill.textContent = product.lastSizeInStock ? 'In stock' : 'Out of stock';
    meta.appendChild(stockPill);
  }

  // Footer: last checked + history button
  const footer = document.createElement('div');
  footer.className = 'pw-item-footer';

  const timeEl = document.createElement('span');
  timeEl.className = 'pw-item-time';
  timeEl.textContent = product.lastChecked
    ? `Updated ${relativeTime(product.lastChecked)}`
    : 'Not yet checked';

  const histBtn = document.createElement('button');
  histBtn.className = 'pw-btn-icon';
  histBtn.title = 'View price history';
  histBtn.setAttribute('aria-label', 'View price history');
  histBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M13 2.05V4.07C16.95 4.55 20 7.92 20 12c0 4.42-3.58 8-8 8s-8-3.58-8-8c0-3.97 2.92-7.28 6.75-7.93V2.05C5.09 2.56 2 6.92 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10c0-5.07-3.75-9.31-8.69-9.93L13 2.05zM12 7l-3.5 3.5L10 12h2V7z" fill="currentColor"/></svg>`;
  histBtn.addEventListener('click', () => openHistory(product));
  footer.appendChild(timeEl);
  footer.appendChild(histBtn);

  body.appendChild(nameEl);
  body.appendChild(meta);
  body.appendChild(footer);

  // ── Actions (delete)
  const actions = document.createElement('div');
  actions.className = 'pw-item-actions';

  const delBtn = document.createElement('button');
  delBtn.className = 'pw-btn-icon';
  delBtn.title = 'Stop tracking';
  delBtn.setAttribute('aria-label', 'Remove from tracking');
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/></svg>`;
  delBtn.addEventListener('click', async () => {
    await deleteProduct(product.url);
  });

  actions.appendChild(delBtn);

  li.appendChild(imgEl);
  li.appendChild(body);
  li.appendChild(actions);

  return li;
}

async function appendPriceTrend(container, product) {
  try {
    const historyKey = `history_${encodeKey(product.url)}`;
    const stored = await chrome.storage.local.get(historyKey);
    const history = stored[historyKey] || [];

    if (history.length < 2) return;

    const latest = history[history.length - 1].price;
    const previous = history[history.length - 2].price;

    if (latest === null || previous === null || latest === previous) return;

    const diff = latest - previous;
    const pct = ((diff / previous) * 100).toFixed(1);
    const isDown = diff < 0;

    const trend = document.createElement('span');
    trend.className = `pw-trend ${isDown ? 'down' : 'up'}`;
    trend.innerHTML = isDown
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>${Math.abs(pct)}%`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14l5-5 5 5z"/></svg>${Math.abs(pct)}%`;
    trend.title = `${isDown ? 'Down' : 'Up'} ${Math.abs(pct)}% from previous check`;

    container.appendChild(trend);
  } catch (_) {}
}

// ─── Delete Product ───────────────────────────────────────────────────────────

async function deleteProduct(url) {
  const { trackedProducts = {} } = await chrome.storage.local.get('trackedProducts');
  delete trackedProducts[url];
  await chrome.storage.local.set({ trackedProducts });

  // Remove history
  const historyKey = `history_${encodeKey(url)}`;
  await chrome.storage.local.remove(historyKey);

  await renderTrackedList();
  showBanner('Product removed from tracking.', 'info');
}

// ─── Price History Modal ──────────────────────────────────────────────────────

async function openHistory(product) {
  const historyKey = `history_${encodeKey(product.url)}`;
  const stored = await chrome.storage.local.get(historyKey);
  const history = stored[historyKey] || [];

  historyTitle.textContent = `History: ${truncate(product.name || 'Product', 30)}`;

  // Render list
  historyList.innerHTML = '';

  if (history.length === 0) {
    const li = document.createElement('li');
    li.className = 'pw-history-entry';
    li.style.justifyContent = 'center';
    li.textContent = 'No history yet. Check back after the next scheduled scan.';
    historyList.appendChild(li);
  } else {
    const minPrice = Math.min(...history.map(h => h.price).filter(p => p !== null));

    for (const entry of [...history].reverse()) {
      const li = document.createElement('li');
      li.className = `pw-history-entry${entry.price === minPrice ? ' lowest' : ''}`;

      const priceSpan = document.createElement('span');
      priceSpan.className = 'he-price';
      priceSpan.textContent = formatPrice(entry.price, product.currency);

      const timeSpan = document.createElement('span');
      timeSpan.className = 'he-time';
      timeSpan.textContent = new Date(entry.timestamp).toLocaleString([], {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      li.appendChild(priceSpan);
      if (entry.price === minPrice) {
        const badge = document.createElement('span');
        badge.className = 'pw-pill in-stock';
        badge.textContent = 'Lowest';
        li.appendChild(badge);
      }
      li.appendChild(timeSpan);
      historyList.appendChild(li);
    }
  }

  // Draw canvas chart
  drawPriceChart(history, product.currency);

  historyOverlay.hidden = false;
}

function drawPriceChart(history, currency = 'USD') {
  const canvas = historyChart;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const prices = history.map(h => h.price).filter(p => p !== null);
  if (prices.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Not enough data yet.', W / 2, H / 2);
    return;
  }

  const pad = { top: 14, right: 14, bottom: 28, left: 44 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const rangeP = maxP - minP || 1;

  const points = history
    .filter(h => h.price !== null)
    .map((h, i, arr) => ({
      x: pad.left + (i / (arr.length - 1)) * cW,
      y: pad.top + cH - ((h.price - minP) / rangeP) * cH,
      price: h.price,
      ts: h.timestamp
    }));

  // Background grid
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.top + (cH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cW, y);
    ctx.stroke();
  }

  // Y-axis labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const price = maxP - (rangeP / 3) * i;
    const y = pad.top + (cH / 3) * i + 3;
    ctx.fillText(formatPrice(price, currency), pad.left - 4, y);
  }

  // Line gradient
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, 'rgba(13,148,136,0.18)');
  grad.addColorStop(1, 'rgba(13,148,136,0)');

  // Area fill
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.lineTo(points[points.length - 1].x, pad.top + cH);
  ctx.lineTo(points[0].x, pad.top + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = '#0d9488';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.stroke();

  // Dots
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // X-axis: first and last date
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  const firstDate = new Date(points[0].ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const lastDate  = new Date(points[points.length - 1].ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  ctx.fillText(firstDate, pad.left, H - 6);
  ctx.textAlign = 'right';
  ctx.fillText(lastDate, pad.left + cW, H - 6);
}

// ─── Status Banner ─────────────────────────────────────────────────────────────

let bannerTimer = null;

function showBanner(message, type = 'info') {
  statusBanner.textContent = message;
  statusBanner.className = `pw-banner ${type}`;
  statusBanner.hidden = false;

  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    statusBanner.hidden = true;
  }, 3500);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

function encodeKey(url) {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
}

function formatPrice(amount, currency = 'USD') {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount}`;
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
