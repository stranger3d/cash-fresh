'use strict';

const STORE_KEY = 'cashfresh:v1';

const DEFAULTS = {
  settings: { value: 1100, maxPerTrip: 8, wallet: 20, monthly: 20 }, // amounts in cents
  cart: [],      // { id, name, price (cents), qty }
  history: [],   // { id, date, total, vouchers, voucherValue, cash, items }
  catalog: {}    // key -> { name, price, barcode, used, count }  (prices remembered for reuse)
};

let pendingBarcode = null;

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
        <span class="item-unit">${euro(it.price)}${it.qty > 1 ? ' cad.' : ''}</span>
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

// ---------- remembered products ----------
const catalogKey = (name, barcode) => barcode ? 'b:' + barcode : (name ? 'n:' + name.toLowerCase() : null);

function remember(name, price, barcode) {
  const key = catalogKey(name, barcode);
  if (!key) return;
  const prev = state.catalog[key] || { count: 0 };
  state.catalog[key] = { name: name || prev.name || '', price, barcode: barcode || null, used: Date.now(), count: prev.count + 1 };
}

function findByName(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return Object.values(state.catalog).find((c) => c.name && c.name.toLowerCase() === n) || null;
}

function renderRecent() {
  const entries = Object.entries(state.catalog).sort((a, b) => b[1].used - a[1].used).slice(0, 12);
  const wrap = $('recent');
  wrap.innerHTML = '';
  entries.forEach(([key, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.key = key;
    b.innerHTML = `<span>${escapeHtml(c.name || 'Cod. ' + (c.barcode || ''))}</span><strong>${euro(c.price)}</strong>`;
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
  const n = Object.keys(state.catalog).length;
  $('catalog-count').textContent = n ? `${n} prodotti con prezzo memorizzato.` : 'Nessun prodotto memorizzato.';
}

function addToCart(name, price, qty, barcode) {
  const same = state.cart.find((x) => x.price === price && x.name === name && (x.barcode || null) === (barcode || null));
  if (same) same.qty += qty;
  else state.cart.push({ id: uid(), name, price, qty, barcode: barcode || null });
  remember(name, price, barcode);
  save();
  render();
}

function renderSettings() {
  const s = state.settings;
  $('s-value').value = (s.value / 100).toFixed(2).replace('.', ',');
  $('s-max').value = s.maxPerTrip;
  $('s-wallet').value = s.wallet;
  $('s-monthly').value = s.monthly;
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
  addToCart($('item-name').value.trim(), price, qty, pendingBarcode);
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
  $('barcode-note').hidden = true;
}

// ---------- barcode scanner ----------
let scanStop = null;

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

async function openScanner() {
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
  const known = state.catalog['b:' + code];
  if (known) {
    addToCart(known.name, known.price, 1, code);
    toast(`${known.name || 'Prodotto'} aggiunto: ${euro(known.price)}`);
    return;
  }
  pendingBarcode = code;
  const note = $('barcode-note');
  note.textContent = `Codice ${code}: nuovo prodotto. Scrivi il prezzo, la prossima volta lo ricordo io.`;
  note.hidden = false;
  $('item-price').focus();
}

function toast(msg) {
  const note = $('barcode-note');
  note.textContent = msg;
  note.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { if (!pendingBarcode) note.hidden = true; }, 2500);
}

$('scan-btn').addEventListener('click', openScanner);
$('scan-close').addEventListener('click', closeScanner);

$('item-price').addEventListener('input', (e) => e.target.classList.remove('invalid'));

$('items').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const it = state.cart.find((x) => x.id === id);
  if (!it) return;
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
