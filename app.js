'use strict';

const STORE_KEY = 'cashfresh:v1';

const DEFAULTS = {
  settings: { value: 1100, maxPerTrip: 8, wallet: 20, monthly: 20, online: true }, // amounts in cents
  cart: [],      // { id, name, price (cents), qty }
  history: [],   // { id, date, total, vouchers, voucherValue, cash, items }
  catalog: {}    // key -> { name, brand, quantity, image, barcode, price, prices: [{ p, d }], used, count }
};

let pendingBarcode = null;
let pendingMeta = null;   // brand/image found online for the barcode being added

let state = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && raw.settings) {
      return {
        settings: { ...DEFAULTS.settings, ...raw.settings },
        cart: Array.isArray(raw.cart) ? raw.cart : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        catalog: raw.catalog && typeof raw.catalog === 'object' ? raw.catalog : {}
      };
    }
  } catch (e) { /* ignore corrupted data */ }
  return structuredClone(DEFAULTS);
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const euro = (cents) => fmt.format(cents / 100);

function parseEuro(str) {
  if (typeof str !== 'string') return NaN;
  const clean = str.trim().replace(/€|\s/g, '').replace(',', '.');
  if (clean === '' || !/^\d*\.?\d*$/.test(clean)) return NaN;
  return Math.round(parseFloat(clean) * 100);
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- core calculation ----------
function computeSplit(total, s) {
  const value = s.value;
  const cap = Math.max(0, Math.min(s.maxPerTrip, s.wallet));
  const full = value > 0 ? Math.floor(total / value) : 0;
  const used = Math.min(full, cap);
  const cash = total - used * value;
  const remainder = total - full * value;           // part of the total below one voucher
  const toNext = remainder > 0 ? value - remainder : 0;
  const limit = cap * value;                         // max spend covered by vouchers
  return { cap, full, used, cash, remainder, toNext, limit, value };
}

// ---------- rendering ----------
function cartTotal() {
  return state.cart.reduce((sum, it) => sum + it.price * it.qty, 0);
}

function render() {
  renderCart();
  renderRecent();
  renderCatalog();
  renderSummary();
  renderHistory();
}

function renderSummary() {
  const total = cartTotal();
  const r = computeSplit(total, state.settings);

  $('total').textContent = euro(total);
  $('vouchers-used').textContent = r.used;
  $('vouchers-amount').textContent = euro(r.used * r.value);
  $('cash-due').textContent = euro(r.cash);

  const pct = r.limit > 0 ? Math.min(100, (total / r.limit) * 100) : 100;
  const fill = $('bar-fill');
  fill.style.width = pct + '%';
  const summary = $('summary');
  summary.classList.toggle('over', total > r.limit);
  summary.classList.toggle('at-limit', r.limit > 0 && total >= r.limit * 0.9 && total <= r.limit);

  $('bar-caption').textContent = r.limit > 0
    ? `${euro(total)} su ${euro(r.limit)} coperti dai buoni (${r.cap} × ${euro(r.value)})`
    : 'Nessun buono disponibile';

  let hint;
  const s = state.settings;
  if (r.cap === 0) {
    hint = s.wallet === 0
      ? 'Hai finito i buoni. Aggiornali in Impostazioni quando arrivano quelli nuovi.'
      : 'Controlla le impostazioni dei buoni.';
  } else if (total === 0) {
    hint = `Puoi spendere fino a ${euro(r.limit)} usando ${r.cap} buoni.`;
  } else if (total > r.limit) {
    const why = s.wallet < s.maxPerTrip ? `ti restano solo ${s.wallet} buoni` : `il massimo è ${s.maxPerTrip} buoni per spesa`;
    hint = `Hai superato il limite dei buoni di ${euro(total - r.limit)}: ${why}.`;
  } else if (total === r.limit) {
    hint = 'Perfetto: usi tutti i buoni possibili senza pagare nulla a parte.';
  } else if (r.remainder === 0) {
    hint = `Cifra esatta: ${r.used} buoni, niente da pagare a parte.`;
  } else {
    hint = `Aggiungi ancora ${euro(r.toNext)} di spesa per sfruttare un altro buono intero.`;
  }
  $('hint').textContent = hint;
}

function renderCart() {
  const list = $('items');
  list.innerHTML = '';
  // newest first
  [...state.cart].reverse().forEach((it) => {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="item-main">
        <span class="item-name">${it.name ? escapeHtml(it.name) : '<span class="muted">Prodotto</span>'}</span>
        <button type="button" class="item-unit" data-act="price" aria-label="Cambia prezzo">${euro(it.price)}${it.qty > 1 ? ' cad.' : ''} <span class="pencil">✎</span></button>
      </div>
      <div class="item-qty">
        <button data-act="dec" aria-label="Meno">−</button>
        <span>${it.qty}</span>
        <button data-act="inc" aria-label="Più">+</button>
      </div>
      <span class="item-total">${euro(it.price * it.qty)}</span>
      <button class="item-del" data-act="del" aria-label="Elimina">✕</button>`;
    list.appendChild(li);
  });
  const empty = state.cart.length === 0;
  $('empty').hidden = !empty;
  $('receipt-title').hidden = empty;
  $('cart-actions').hidden = empty;
}

function renderHistory() {
  const now = new Date();
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const thisMonth = state.history.filter((h) => monthKey(new Date(h.date)) === monthKey(now));
  $('month-title').textContent = now.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
  $('m-total').textContent = euro(thisMonth.reduce((a, h) => a + h.total, 0));
  $('m-vouchers').textContent = thisMonth.reduce((a, h) => a + h.vouchers, 0);
  $('m-cash').textContent = euro(thisMonth.reduce((a, h) => a + h.cash, 0));

  const list = $('history');
  list.innerHTML = '';
  [...state.history].reverse().forEach((h) => {
    const li = document.createElement('li');
    li.className = 'card trip';
    const d = new Date(h.date);
    li.innerHTML = `
      <div class="trip-head">
        <span>${d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
        <strong>${euro(h.total)}</strong>
      </div>
      <div class="trip-sub">${h.vouchers} buoni (${euro(h.vouchers * h.voucherValue)}) · ${euro(h.cash)} a parte · ${h.items.length} prodotti</div>
      <button class="ghost small danger" data-del="${h.id}">Elimina</button>`;
    list.appendChild(li);
  });
  $('history-empty').hidden = state.history.length > 0;
}

// ---------- product database ----------
const catalogKey = (name, barcode) => barcode ? 'b:' + barcode : (name ? 'n:' + name.toLowerCase() : null);
const MAX_PRICES = 30;

function pushPrice(c, price, when) {
  if (!Array.isArray(c.prices)) c.prices = c.price ? [{ p: c.price, d: c.used || when }] : [];
  const last = c.prices[c.prices.length - 1];
  if (last && last.p === price) last.d = when;
  else c.prices.push({ p: price, d: when });
  if (c.prices.length > MAX_PRICES) c.prices = c.prices.slice(-MAX_PRICES);
}

function remember(name, price, barcode, meta) {
  const key = catalogKey(name, barcode);
  if (!key) return;
  const now = Date.now();
  const prev = state.catalog[key] || { count: 0 };
  const c = { ...prev, ...(meta || {}) };
  c.name = name || prev.name || '';
  c.barcode = barcode || null;
  pushPrice(c, price, now);
  c.price = price;
  c.used = now;
  c.count = (prev.count || 0) + 1;
  state.catalog[key] = c;
}

function findByName(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return Object.values(state.catalog).find((c) => c.name && c.name.toLowerCase() === n) || null;
}

const productLabel = (c) => c.name || (c.barcode ? 'Cod. ' + c.barcode : 'Prodotto');
const safeImg = (u) => (typeof u === 'string' && /^https:\/\//.test(u)) ? u : '';

function renderRecent() {
  const entries = Object.entries(state.catalog).sort((a, b) => b[1].used - a[1].used).slice(0, 12);
  const wrap = $('recent');
  wrap.innerHTML = '';
  entries.forEach(([key, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.key = key;
    b.innerHTML = `<span>${escapeHtml(productLabel(c))}</span><strong>${euro(c.price)}</strong>`;
    wrap.appendChild(b);
  });
  $('recent-wrap').hidden = entries.length === 0;

  const dl = $('known-names');
  dl.innerHTML = '';
  Object.values(state.catalog).filter((c) => c.name).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.name;
    dl.appendChild(o);
  });
}

function priceRange(c) {
  const ps = (c.prices || []).map((x) => x.p);
  if (ps.length < 2) return '';
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? '' : `${euro(lo)} – ${euro(hi)}`;
}

function renderCatalog() {
  const all = Object.entries(state.catalog);
  const q = $('cat-search').value.trim().toLowerCase();
  const sort = $('cat-sort').value;
  let rows = q
    ? all.filter(([, c]) => [c.name, c.brand, c.barcode].some((v) => v && String(v).toLowerCase().includes(q)))
    : all;
  const cmp = {
    used: (a, b) => (b[1].used || 0) - (a[1].used || 0),
    count: (a, b) => (b[1].count || 0) - (a[1].count || 0),
    name: (a, b) => productLabel(a[1]).localeCompare(productLabel(b[1]), 'it'),
    price: (a, b) => a[1].price - b[1].price
  }[sort] || (() => 0);
  rows = rows.sort(cmp);

  const list = $('catalog');
  list.innerHTML = '';
  rows.forEach(([key, c]) => {
    const li = document.createElement('li');
    li.className = 'prod';
    li.dataset.key = key;
    const img = safeImg(c.image);
    const sub = [c.brand, c.quantity, priceRange(c)].filter(Boolean).map(escapeHtml).join(' · ');
    li.innerHTML = `
      <div class="prod-thumb">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : ''}<span>${escapeHtml(productLabel(c).charAt(0).toUpperCase())}</span></div>
      <div class="prod-main">
        <span class="prod-name">${escapeHtml(productLabel(c))}</span>
        <span class="prod-sub">${sub || (c.barcode ? escapeHtml(c.barcode) : '&nbsp;')}</span>
      </div>
      <span class="prod-price">${euro(c.price)}</span>
      <button type="button" class="prod-add" data-add="${escapeHtml(key)}" aria-label="Aggiungi alla spesa">+</button>`;
    const im = li.querySelector('img');
    if (im) im.addEventListener('error', () => im.remove());
    list.appendChild(li);
  });
  const n = all.length;
  $('catalog-count').textContent = n
    ? (q ? `${rows.length} di ${n} prodotti` : `${n} prodotti salvati`)
    : '';
  $('catalog-empty').hidden = n > 0;
  if (n > 0 && rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nessun prodotto trovato.';
    list.appendChild(li);
  }
}

// ---------- Open Food Facts lookup (free, no key) ----------
const offCache = new Map();

async function lookupProduct(code) {
  if (!state.settings.online || !/^\d{6,14}$/.test(code)) return null;
  if (offCache.has(code)) return offCache.get(code);
  if (navigator.onLine === false) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const fields = 'product_name,product_name_it,generic_name_it,brands,quantity,image_front_small_url,image_small_url';
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`, { signal: ctrl.signal });
    if (!res.ok) { offCache.set(code, null); return null; }
    const data = await res.json();
    const p = data && data.status === 1 ? data.product : null;
    if (!p) { offCache.set(code, null); return null; }
    let name = (p.product_name_it || p.product_name || p.generic_name_it || '').trim();
    const quantity = (p.quantity || '').trim();
    if (name && quantity && !name.toLowerCase().includes(quantity.toLowerCase())) name += ' ' + quantity;
    const brand = (p.brands || '').split(',')[0].trim();
    const out = name || brand ? { name, brand, quantity, image: safeImg(p.image_front_small_url || p.image_small_url) } : null;
    offCache.set(code, out);
    return out;
  } catch (e) {
    return null; // offline or timeout: the user just types the name
  } finally {
    clearTimeout(timer);
  }
}

function addToCart(name, price, qty, barcode, meta) {
  let item = state.cart.find((x) => x.price === price && x.name === name && (x.barcode || null) === (barcode || null));
  if (item) item.qty += qty;
  else state.cart.push(item = { id: uid(), name, price, qty, barcode: barcode || null });
  remember(name, price, barcode, meta);
  save();
  render();
  return item;
}

// Prices change from week to week: tap a price on the receipt to fix it.
// The product database learns the new price and keeps the old one in its history.
function startPriceEdit(id) {
  const it = state.cart.find((x) => x.id === id);
  const li = document.querySelector(`.item[data-id="${id}"]`);
  if (!it || !li) return;
  const btn = li.querySelector('.item-unit');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.enterKeyHint = 'done';
  input.className = 'unit-input';
  input.value = fmtPriceInput(it.price);
  input.setAttribute('aria-label', 'Nuovo prezzo');
  btn.replaceWith(input);
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input.focus();
  input.select();
  let done = false;
  const commit = (keep) => {
    if (done) return;
    done = true;
    const price = parseEuro(input.value);
    if (keep && Number.isFinite(price) && price > 0 && price !== it.price) {
      it.price = price;
      updateCatalogPrice(it.name, it.barcode, price);
      const twin = state.cart.find((x) => x !== it && x.price === price && x.name === it.name && (x.barcode || null) === (it.barcode || null));
      if (twin) { twin.qty += it.qty; state.cart = state.cart.filter((x) => x !== it); }
      save();
      toast(`Prezzo aggiornato: ${euro(price)}`);
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

function updateCatalogPrice(name, barcode, price) {
  const key = catalogKey(name, barcode);
  const c = key && state.catalog[key];
  if (!c) return;
  pushPrice(c, price, Date.now());
  c.price = price;
}

function renderSettings() {
  const s = state.settings;
  $('s-value').value = (s.value / 100).toFixed(2).replace('.', ',');
  $('s-max').value = s.maxPerTrip;
  $('s-wallet').value = s.wallet;
  $('s-monthly').value = s.monthly;
  $('s-online').checked = s.online !== false;
}

// ---------- events ----------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
    if (btn.dataset.view === 'impostazioni') renderSettings();
    window.scrollTo(0, 0);
  });
});

document.querySelectorAll('.stepper button').forEach((b) => {
  b.addEventListener('click', () => {
    const q = $('item-qty');
    q.value = Math.max(1, (parseInt(q.value, 10) || 1) + parseInt(b.dataset.step, 10));
  });
});

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const price = parseEuro($('item-price').value);
  const qty = Math.max(1, parseInt($('item-qty').value, 10) || 1);
  if (!Number.isFinite(price) || price <= 0) {
    $('item-price').classList.add('invalid');
    $('item-price').focus();
    return;
  }
  $('item-price').classList.remove('invalid');
  addToCart($('item-name').value.trim(), price, qty, pendingBarcode, pendingMeta);
  clearPendingBarcode();
  $('item-name').value = '';
  $('item-price').value = '';
  $('item-qty').value = 1;
  $('item-price').focus();
});

// typing a known product name fills in its last price
$('item-name').addEventListener('change', () => {
  const c = findByName($('item-name').value.trim());
  if (c && !$('item-price').value) $('item-price').value = (c.price / 100).toFixed(2).replace('.', ',');
});

$('recent').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const c = state.catalog[b.dataset.key];
  if (c) addToCart(c.name, c.price, 1, c.barcode);
});

$('clear-catalog').addEventListener('click', () => {
  if (!confirm('Dimenticare tutti i prezzi memorizzati?')) return;
  state.catalog = {};
  save();
  render();
});

function clearPendingBarcode() {
  pendingBarcode = null;
  pendingMeta = null;
  $('barcode-note').hidden = true;
}

// ---------- barcode scanner ----------
let scanStop = null;
let scanMode = 'cart'; // 'cart' adds to the trip, 'catalog' opens the product editor

function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/zxing.min.js';
    sc.onload = () => resolve(window.ZXing);
    sc.onerror = reject;
    document.head.appendChild(sc);
  });
}

async function openScanner(mode) {
  scanMode = mode === 'catalog' ? 'catalog' : 'cart';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('La fotocamera non è disponibile su questo browser. Inserisci il prezzo a mano.');
    return;
  }
  const video = $('scan-video');
  $('scan-msg').textContent = 'Inquadra il codice a barre';
  $('scanner').hidden = false;
  const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
  try {
    if ('BarcodeDetector' in window) {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      let alive = true;
      scanStop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); };
      const tick = async () => {
        if (!alive) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) return onBarcode(codes[0].rawValue);
        } catch (e) { /* keep trying */ }
        setTimeout(tick, 150);
      };
      tick();
    } else {
      const ZX = await loadZxing();
      const hints = new Map();
      hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
        ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.CODE_128
      ]);
      const reader = new ZX.BrowserMultiFormatReader(hints, 200);
      scanStop = () => reader.reset();
      await reader.decodeFromConstraints(constraints, video, (result) => {
        if (result) onBarcode(result.getText());
      });
    }
  } catch (err) {
    closeScanner();
    alert('Non riesco ad accedere alla fotocamera. Controlla i permessi di Safari oppure inserisci il prezzo a mano.');
  }
}

function closeScanner() {
  if (scanStop) { try { scanStop(); } catch (e) { /* ignore */ } }
  scanStop = null;
  const video = $('scan-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  $('scanner').hidden = true;
}

function onBarcode(code) {
  if (!scanStop) return; // already handled
  if (navigator.vibrate) navigator.vibrate(60);
  closeScanner();
  if (scanMode === 'catalog') return openEditor('b:' + code, code);
  const known = state.catalog['b:' + code];
  if (known) {
    const item = addToCart(known.name, known.price, 1, code);
    toast(`${productLabel(known)}: ${euro(known.price)} · tocca per cambiare prezzo`, () => startPriceEdit(item.id));
    if (!known.name) enrich(code);
    return;
  }
  pendingBarcode = code;
  pendingMeta = null;
  const note = $('barcode-note');
  note.hidden = false;
  $('item-price').focus();
  if (!state.settings.online) {
    note.textContent = `Codice ${code}: nuovo prodotto. Scrivi il prezzo, la prossima volta lo ricordo io.`;
    return;
  }
  note.textContent = `Codice ${code}: cerco il prodotto…`;
  lookupProduct(code).then((p) => {
    if (pendingBarcode !== code) return; // user already moved on
    if (p) {
      pendingMeta = { brand: p.brand, quantity: p.quantity, image: p.image };
      if (p.name && !$('item-name').value.trim()) $('item-name').value = p.name;
      note.textContent = `Trovato: ${p.name || p.brand}${p.brand && p.name ? ' (' + p.brand + ')' : ''}. Scrivi il prezzo, la prossima volta lo ricordo io.`;
    } else {
      note.textContent = `Codice ${code}: nuovo prodotto. Scrivi nome e prezzo, la prossima volta li ricordo io.`;
    }
  });
}

// fill in name/brand for a saved barcode that has none yet
async function enrich(code) {
  const p = await lookupProduct(code);
  const c = state.catalog['b:' + code];
  if (!p || !c) return;
  if (!c.name) c.name = p.name;
  if (!c.brand) c.brand = p.brand;
  if (!c.image) c.image = p.image;
  if (!c.quantity) c.quantity = p.quantity;
  state.cart.forEach((it) => { if (it.barcode === code && !it.name) it.name = c.name; });
  save();
  render();
}

// ---------- product editor ----------
let editKey = null;
let editMeta = null;

function fmtPriceInput(cents) {
  return Number.isFinite(cents) ? (cents / 100).toFixed(2).replace('.', ',') : '';
}

function openEditor(key, barcode) {
  const c = key ? state.catalog[key] : null;
  editKey = c ? key : null;
  editMeta = c ? { image: c.image || '', quantity: c.quantity || '' } : { image: '', quantity: '' };
  const code = c ? (c.barcode || '') : (barcode || '');
  $('pd-title').textContent = c ? productLabel(c) : 'Nuovo prodotto';
  $('pd-name').value = c ? c.name || '' : '';
  $('pd-brand').value = c ? c.brand || '' : '';
  $('pd-barcode').value = code;
  $('pd-price').value = c ? fmtPriceInput(c.price) : '';
  $('pd-price').classList.remove('invalid');
  $('pd-code').textContent = c && c.count ? `Comprato ${c.count} ${c.count === 1 ? 'volta' : 'volte'}` : '';
  $('pd-delete').hidden = !c;
  setEditorImage(editMeta.image);
  renderPriceHistory(c);
  const status = $('pd-status');
  status.hidden = true;
  $('prod-dialog').showModal();

  if (code && (!c || !c.name)) {
    if (!state.settings.online) return;
    status.textContent = 'Cerco il prodotto su Open Food Facts…';
    status.hidden = false;
    lookupProduct(code).then((p) => {
      if (!$('prod-dialog').open || $('pd-barcode').value.trim() !== code) return;
      if (!p) { status.textContent = 'Non trovato online: scrivi tu il nome.'; return; }
      status.textContent = 'Trovato su Open Food Facts ✓';
      if (!$('pd-name').value.trim()) $('pd-name').value = p.name;
      if (!$('pd-brand').value.trim()) $('pd-brand').value = p.brand;
      if (!editMeta.image) { editMeta.image = p.image; setEditorImage(p.image); }
      if (!editMeta.quantity) editMeta.quantity = p.quantity;
      if (!c) $('pd-title').textContent = p.name || 'Nuovo prodotto';
    });
  }
  if (!c) setTimeout(() => (code ? $('pd-price') : $('pd-name')).focus(), 50);
}

function setEditorImage(url) {
  const img = $('pd-img');
  const u = safeImg(url);
  img.hidden = !u;
  if (u) { img.src = u; img.onerror = () => { img.hidden = true; }; } else img.removeAttribute('src');
}

function renderPriceHistory(c) {
  const box = $('pd-history');
  const ps = c && Array.isArray(c.prices) ? c.prices : [];
  if (ps.length < 2) { box.innerHTML = ''; return; }
  const day = (d) => new Date(d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  box.innerHTML = '<span class="muted small-text">Prezzi visti</span><div class="ph-list">' +
    [...ps].reverse().slice(0, 8).map((x) => `<span><strong>${euro(x.p)}</strong> ${day(x.d)}</span>`).join('') +
    '</div>';
}

$('prod-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const action = e.submitter ? e.submitter.value : 'save';
  const dialog = $('prod-dialog');
  if (action === 'cancel') return dialog.close();
  if (action === 'delete') {
    if (editKey && confirm('Eliminare questo prodotto dal database?')) {
      delete state.catalog[editKey];
      save();
      render();
      dialog.close();
    }
    return;
  }
  const name = $('pd-name').value.trim();
  const brand = $('pd-brand').value.trim();
  const barcode = $('pd-barcode').value.replace(/\s/g, '');
  const price = parseEuro($('pd-price').value);
  if (!Number.isFinite(price) || price <= 0) {
    $('pd-price').classList.add('invalid');
    $('pd-price').focus();
    return;
  }
  const key = catalogKey(name, barcode);
  if (!key) { $('pd-name').focus(); return; }
  const now = Date.now();
  const prev = editKey ? state.catalog[editKey] : null;
  const other = key !== editKey ? state.catalog[key] : null;
  const c = { ...(other || {}), ...(prev || {}) };
  c.name = name;
  c.brand = brand;
  c.barcode = barcode || null;
  c.image = editMeta.image || c.image || '';
  c.quantity = editMeta.quantity || c.quantity || '';
  if (other && prev) {
    c.count = (prev.count || 0) + (other.count || 0);
    c.prices = [...(other.prices || []), ...(prev.prices || [])].sort((a, b) => a.d - b.d).slice(-MAX_PRICES);
  }
  if (c.price !== price) pushPrice(c, price, now);
  c.price = price;
  c.count = c.count || 0;
  c.used = c.used || now;
  if (editKey && editKey !== key) delete state.catalog[editKey];
  state.catalog[key] = c;
  save();
  dialog.close();
  if (action === 'cart') {
    addToCart(c.name, c.price, 1, c.barcode);
    toast(`${productLabel(c)} aggiunto: ${euro(c.price)}`);
  } else {
    render();
  }
});

function toast(msg, action) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('actionable', !!action);
  toast.action = action || null;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; toast.action = null; }, action ? 5000 : 2200);
}

$('toast').addEventListener('click', () => {
  const act = toast.action;
  $('toast').hidden = true;
  toast.action = null;
  if (act) act();
});

$('scan-btn').addEventListener('click', () => openScanner('cart'));
$('cat-scan').addEventListener('click', () => openScanner('catalog'));
$('cat-new').addEventListener('click', () => openEditor(null, ''));
$('cat-search').addEventListener('input', renderCatalog);
$('cat-sort').addEventListener('change', renderCatalog);
$('catalog').addEventListener('click', (e) => {
  const add = e.target.closest('button[data-add]');
  if (add) {
    const c = state.catalog[add.dataset.add];
    if (!c) return;
    addToCart(c.name, c.price, 1, c.barcode);
    toast(`${productLabel(c)} aggiunto: ${euro(c.price)}`);
    add.classList.add('done');
    setTimeout(() => add.classList.remove('done'), 600);
    return;
  }
  const row = e.target.closest('.prod');
  if (row) openEditor(row.dataset.key);
});

$('s-online').addEventListener('change', (e) => {
  state.settings.online = e.target.checked;
  save();
});

// ---------- backup ----------
$('cat-export').addEventListener('click', async () => {
  const n = Object.keys(state.catalog).length;
  if (!n) return alert('Non ci sono prodotti da esportare.');
  const data = JSON.stringify({ app: 'cash-fresh', type: 'catalog', version: 1, exported: new Date().toISOString(), catalog: state.catalog }, null, 1);
  const name = `cash-fresh-prodotti-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Backup prodotti Cash Fresh' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('cat-import').addEventListener('click', () => $('cat-file').click());
$('cat-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const n = importCatalog(raw && raw.catalog ? raw.catalog : raw);
    save();
    render();
    alert(n ? `Importati ${n} prodotti.` : 'Nessun prodotto valido nel file.');
  } catch (err) {
    alert('File non valido: serve un backup esportato da Cash Fresh.');
  }
});

function importCatalog(cat) {
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) throw new Error('bad');
  let n = 0;
  Object.values(cat).forEach((x) => {
    if (!x || typeof x !== 'object') return;
    const price = Math.round(Number(x.price));
    const name = typeof x.name === 'string' ? x.name.slice(0, 120) : '';
    const barcode = typeof x.barcode === 'string' && x.barcode ? x.barcode.slice(0, 32) : null;
    const key = catalogKey(name, barcode);
    if (!key || !Number.isFinite(price) || price <= 0) return;
    const prices = Array.isArray(x.prices)
      ? x.prices.filter((p) => p && Number.isFinite(p.p) && Number.isFinite(p.d)).map((p) => ({ p: Math.round(p.p), d: p.d }))
      : [];
    const inc = {
      name, barcode, price,
      brand: typeof x.brand === 'string' ? x.brand.slice(0, 80) : '',
      quantity: typeof x.quantity === 'string' ? x.quantity.slice(0, 40) : '',
      image: safeImg(x.image),
      prices,
      used: Number.isFinite(x.used) ? x.used : Date.now(),
      count: Number.isFinite(x.count) ? x.count : 0
    };
    const cur = state.catalog[key];
    if (cur) {
      const newer = (inc.used || 0) > (cur.used || 0) ? inc : cur;
      const seen = new Set();
      const merged = [...(cur.prices || []), ...prices]
        .sort((a, b) => a.d - b.d)
        .filter((p) => { const k = p.p + ':' + p.d; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(-MAX_PRICES);
      state.catalog[key] = { ...cur, ...inc, ...newer, brand: newer.brand || cur.brand || inc.brand, image: newer.image || cur.image || inc.image, prices: merged, count: Math.max(cur.count || 0, inc.count) };
    } else {
      state.catalog[key] = inc;
    }
    n++;
  });
  return n;
}
$('scan-close').addEventListener('click', closeScanner);

$('item-price').addEventListener('input', (e) => e.target.classList.remove('invalid'));

$('items').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const it = state.cart.find((x) => x.id === id);
  if (!it) return;
  if (btn.dataset.act === 'price') return startPriceEdit(id);
  if (btn.dataset.act === 'inc') it.qty++;
  if (btn.dataset.act === 'dec') {
    if (it.qty > 1) it.qty--;
    else state.cart = state.cart.filter((x) => x.id !== id);
  }
  if (btn.dataset.act === 'del') state.cart = state.cart.filter((x) => x.id !== id);
  save();
  render();
});

$('clear-trip').addEventListener('click', () => {
  if (!confirm('Svuotare la spesa in corso?')) return;
  state.cart = [];
  save();
  render();
});

$('close-trip').addEventListener('click', () => {
  const total = cartTotal();
  const r = computeSplit(total, state.settings);
  const msg = `Concludere la spesa?\n\nTotale ${euro(total)}\nBuoni: ${r.used} (${euro(r.used * r.value)})\nA parte: ${euro(r.cash)}`;
  if (!confirm(msg)) return;
  state.history.push({
    id: uid(),
    date: new Date().toISOString(),
    total,
    vouchers: r.used,
    voucherValue: r.value,
    cash: r.cash,
    items: state.cart
  });
  state.settings.wallet = Math.max(0, state.settings.wallet - r.used);
  state.cart = [];
  save();
  render();
});

$('history').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-del]');
  if (!btn) return;
  const h = state.history.find((x) => x.id === btn.dataset.del);
  if (!h) return;
  if (!confirm(`Eliminare questa spesa? I ${h.vouchers} buoni usati verranno restituiti al saldo.`)) return;
  state.history = state.history.filter((x) => x.id !== h.id);
  state.settings.wallet += h.vouchers;
  save();
  render();
});

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = parseEuro($('s-value').value);
  if (!Number.isFinite(value) || value <= 0) {
    $('s-value').classList.add('invalid');
    return;
  }
  $('s-value').classList.remove('invalid');
  state.settings = {
    ...state.settings,
    value,
    maxPerTrip: Math.max(1, parseInt($('s-max').value, 10) || 8),
    wallet: Math.max(0, parseInt($('s-wallet').value, 10) || 0),
    monthly: Math.max(0, parseInt($('s-monthly').value, 10) || 0)
  };
  save();
  renderSettings();
  render();
  flashSaved();
});

$('refill').addEventListener('click', () => {
  const n = state.settings.monthly;
  if (!confirm(`Aggiungere ${n} buoni al saldo attuale (${state.settings.wallet})?`)) return;
  state.settings.wallet += n;
  save();
  renderSettings();
  render();
  flashSaved();
});

$('reset-all').addEventListener('click', () => {
  if (!confirm('Cancellare impostazioni, spesa in corso e storico?')) return;
  localStorage.removeItem(STORE_KEY);
  state = structuredClone(DEFAULTS);
  renderSettings();
  render();
});

function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => { el.hidden = true; }, 1500);
}

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
