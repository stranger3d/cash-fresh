'use strict';

const STORE_KEY = 'cashfresh:v1';

const DEFAULTS = {
  settings: { value: 1100, maxPerTrip: 8, wallet: 20, monthly: 20, online: true, theme: 'auto' }, // amounts in cents
  cart: [],      // { id, name, price (cents), qty }
  list: [],      // shopping list: { id, name, qty, key (catalog key or null), done, cartId, added }
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
        list: Array.isArray(raw.list) ? raw.list : [],
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
  syncList();
  renderCart();
  renderList();
  renderRecent();
  renderCatalog();
  renderSummary();
  renderHistory();
}

function renderSummary() {
  const total = cartTotal();
  const r = computeSplit(total, state.settings);

  countTo($('total'), total);
  $('vouchers-used').textContent = r.used;
  $('vouchers-amount').textContent = euro(r.used * r.value);
  countTo($('cash-due'), r.cash);
  countTo($('l-total'), total);
  $('l-vouchers').textContent = r.used;
  countTo($('l-cash'), r.cash);

  [['summary', 'bar-fill', 'bar-ticks'], ['mini-summary', 'l-bar-fill', 'l-bar-ticks']].forEach(([box, fill, ticks]) => {
    paintBar($(fill), $(ticks), total, r);
    $(box).classList.toggle('over', total > r.limit);
    $(box).classList.toggle('at-limit', r.limit > 0 && total >= r.limit * 0.9 && total <= r.limit);
  });

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

// Progress bar toward the voucher limit, with one notch per voucher.
function paintBar(fill, ticks, total, r) {
  const pct = r.limit > 0 ? Math.min(100, (total / r.limit) * 100) : 100;
  fill.style.width = pct + '%';
  const n = r.cap;
  if (ticks.dataset.n !== String(n)) {
    ticks.dataset.n = n;
    ticks.innerHTML = n > 1 && n <= 30 ? Array.from({ length: n - 1 }, (_, i) => `<i style="left:${((i + 1) * 100) / n}%"></i>`).join('') : '';
  }
}

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Animate a euro amount from its previous value to the new one.
function countTo(el, cents) {
  const from = Number(el.dataset.cents);
  el.dataset.cents = cents;
  cancelAnimationFrame(el._raf);
  if (!Number.isFinite(from) || from === cents || reduceMotion() || document.hidden) {
    el.textContent = euro(cents);
    return;
  }
  el.classList.remove('bump');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('bump');
  const t0 = performance.now();
  const dur = 320;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = euro(Math.round(from + (cents - from) * e));
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

let lastAddedId = null; // the receipt line that just changed gets a short highlight

function renderCart() {
  const list = $('items');
  list.innerHTML = '';
  // newest first
  [...state.cart].reverse().forEach((it) => {
    const li = document.createElement('li');
    li.className = 'item' + (it.id === lastAddedId ? ' enter' : '');
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
  lastAddedId = null;
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

// ---------- shopping list ----------
// Prepare the list at home, tick items off in the store: each tick puts the
// product on the virtual receipt at its remembered price, so the total updates.
const listPrice = (l) => {
  const c = l.key && state.catalog[l.key];
  return c && c.price > 0 ? c.price : null;
};

function findListMatch(name, barcode) {
  const key = catalogKey(name, barcode);
  const n = (name || '').toLowerCase();
  return state.list.find((l) => !l.done && ((key && l.key === key) || (n && l.name.toLowerCase() === n))) || null;
}

function catalogKeyByName(name) {
  const n = name.toLowerCase();
  const hit = Object.entries(state.catalog).find(([, c]) => c.name && c.name.toLowerCase() === n);
  return hit ? hit[0] : null;
}

function addToList(name, key) {
  name = (name || '').trim().slice(0, 120);
  if (!name && !key) return null;
  const c = key ? state.catalog[key] : null;
  if (c && !name) name = productLabel(c);
  key = key || catalogKeyByName(name);
  const n = name.toLowerCase();
  let l = state.list.find((x) => !x.done && ((key && x.key === key) || x.name.toLowerCase() === n));
  if (l) l.qty++;
  else state.list.push(l = { id: uid(), name, qty: 1, key: key || null, done: false, cartId: null, added: 0 });
  listEnterId = l.id;
  save();
  render();
  return l;
}

// Keep ticks honest when the receipt changes elsewhere (line deleted, receipt emptied, price merged).
function syncList() {
  let changed = false;
  state.list.forEach((l) => {
    if (!l.done || state.cart.some((x) => x.id === l.cartId)) return;
    const twin = l.key && state.cart.find((x) => catalogKey(x.name, x.barcode) === l.key);
    if (twin) l.cartId = twin.id;
    else { l.done = false; l.cartId = null; l.added = 0; }
    changed = true;
  });
  if (changed) save();
}

function tickItem(l, price) {
  const c = l.key ? state.catalog[l.key] : null;
  const name = c ? c.name : l.name;
  const barcode = c ? c.barcode : null;
  const item = addToCart(name, price, l.qty, barcode, null, true);
  l.done = true;
  l.cartId = item.id;
  l.added = l.qty;
  l.key = catalogKey(name, barcode);
  save();
  render();
  toast(`Preso: ${productLabel({ name, barcode })} · ${euro(price * l.qty)}`);
}

function untickItem(l) {
  const it = state.cart.find((x) => x.id === l.cartId);
  if (it) {
    it.qty -= l.added || l.qty;
    if (it.qty <= 0) state.cart = state.cart.filter((x) => x !== it);
  }
  l.done = false;
  l.cartId = null;
  l.added = 0;
  save();
  render();
}

let listEnterId = null;

function renderList() {
  const ul = $('shop-list');
  ul.innerHTML = '';
  const todo = state.list.filter((l) => !l.done);
  const done = state.list.filter((l) => l.done);
  [...todo, ...done].forEach((l) => {
    const li = document.createElement('li');
    li.className = 'li-row' + (l.done ? ' done' : '') + (l.id === listEnterId ? ' enter' : '');
    li.dataset.id = l.id;
    let sub;
    if (l.done) {
      const it = state.cart.find((x) => x.id === l.cartId);
      sub = it
        ? `<button type="button" class="item-unit" data-act="price" aria-label="Cambia prezzo">${l.added > 1 ? l.added + ' × ' : ''}${euro(it.price)} <span class="pencil">✎</span></button>`
        : '';
    } else {
      const p = listPrice(l);
      sub = `<span class="li-sub">${p ? `${l.qty > 1 ? l.qty + ' × ' : ''}${euro(p)}` : 'Prezzo da scrivere quando lo prendi'}</span>`;
    }
    li.innerHTML = `
      <button type="button" class="tick" data-act="tick" aria-label="${l.done ? 'Togli la spunta' : 'Preso'}" aria-pressed="${l.done}">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </button>
      <div class="li-main">
        <span class="li-name">${escapeHtml(l.name || 'Prodotto')}</span>
        ${sub}
      </div>
      ${l.done ? '' : `<div class="item-qty">
        <button type="button" data-act="dec" aria-label="Meno">−</button>
        <span>${l.qty}</span>
        <button type="button" data-act="inc" aria-label="Più">+</button>
      </div>`}
      <button type="button" class="item-del" data-act="del" aria-label="Togli dalla lista">✕</button>`;
    ul.appendChild(li);
  });
  listEnterId = null;

  const n = state.list.length;
  $('list-empty').hidden = n > 0;
  $('list-head').hidden = n === 0;
  $('list-actions').hidden = n === 0;
  $('list-clear-done').hidden = done.length === 0;
  $('list-title').textContent = todo.length ? `Da prendere (${todo.length})` : 'Hai preso tutto ✓';
  const known = todo.filter((l) => listPrice(l));
  const est = known.reduce((a, l) => a + listPrice(l) * l.qty, 0);
  $('list-estimate').textContent = known.length
    ? `circa ${euro(est)}${known.length < todo.length ? ' (senza i prezzi mancanti)' : ''}`
    : '';

  const badge = $('list-badge');
  badge.hidden = todo.length === 0;
  badge.textContent = todo.length;
  const link = $('list-link');
  link.hidden = todo.length === 0;
  $('list-link-text').textContent = todo.length === 1 ? 'Lista: ancora 1 prodotto da prendere' : `Lista: ancora ${todo.length} prodotti da prendere`;

  renderListOften();
  renderSuggest();
}

function renderListOften() {
  const inList = new Set(state.list.filter((l) => !l.done && l.key).map((l) => l.key));
  const rows = Object.entries(state.catalog)
    .filter(([k]) => !inList.has(k))
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || (b[1].used || 0) - (a[1].used || 0))
    .slice(0, 12);
  const wrap = $('list-often');
  wrap.innerHTML = '';
  rows.forEach(([key, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.key = key;
    b.innerHTML = `<span>${escapeHtml(productLabel(c))}</span><strong>${euro(c.price)}</strong>`;
    wrap.appendChild(b);
  });
  $('list-often-wrap').hidden = rows.length === 0;
}

// products from the catalog that match what is being typed
function renderSuggest() {
  const box = $('list-suggest');
  const q = $('list-name').value.trim().toLowerCase();
  box.innerHTML = '';
  if (!q) return;
  Object.entries(state.catalog)
    .filter(([, c]) => [c.name, c.brand].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 6)
    .forEach(([key, c]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sug';
      b.dataset.key = key;
      b.innerHTML = `<span>${escapeHtml(productLabel(c))}${c.brand ? ` <em>${escapeHtml(c.brand)}</em>` : ''}</span><strong>${euro(c.price)}</strong>`;
      box.appendChild(b);
    });
}

// Item with no known price: ask for it right in the list row.
function askListPrice(l, li, onPrice) {
  const main = li.querySelector('.li-main');
  const old = main.querySelector('.li-sub, .item-unit');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.enterKeyHint = 'done';
  input.className = 'unit-input';
  input.placeholder = 'Prezzo €';
  input.setAttribute('aria-label', 'Prezzo');
  const cur = state.cart.find((x) => x.id === l.cartId);
  if (cur) input.value = fmtPriceInput(cur.price);
  if (old) old.replaceWith(input); else main.appendChild(input);
  input.focus();
  if (cur) input.select();
  let finished = false;
  const commit = (keep) => {
    if (finished) return;
    finished = true;
    const price = parseEuro(input.value);
    if (keep && Number.isFinite(price) && price > 0) onPrice(price);
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

$('list-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('list-name').value.trim();
  if (!name) return $('list-name').focus();
  addToList(name, null);
  $('list-name').value = '';
  renderSuggest();
  $('list-name').focus();
});
$('list-name').addEventListener('input', renderSuggest);
$('list-suggest').addEventListener('mousedown', (e) => e.preventDefault()); // keep the keyboard open
$('list-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('.sug');
  if (!b) return;
  addToList('', b.dataset.key);
  $('list-name').value = '';
  renderSuggest();
});
$('list-often').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) addToList('', b.dataset.key);
});

$('shop-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('.li-row');
  const l = state.list.find((x) => x.id === li.dataset.id);
  if (!l) return;
  const act = btn.dataset.act;
  if (act === 'tick') {
    if (l.done) return untickItem(l);
    const p = listPrice(l);
    if (p) return tickItem(l, p);
    return askListPrice(l, li, (price) => tickItem(l, price));
  }
  if (act === 'price') {
    return askListPrice(l, li, (price) => {
      const it = state.cart.find((x) => x.id === l.cartId);
      if (it) setCartPrice(it, price);
      render();
    });
  }
  if (act === 'inc') l.qty++;
  if (act === 'dec') {
    if (l.qty > 1) l.qty--;
    else return removeRow(li, () => { state.list = state.list.filter((x) => x !== l); });
  }
  if (act === 'del') {
    // removing a ticked item keeps the product on the receipt: it was bought
    return removeRow(li, () => { state.list = state.list.filter((x) => x !== l); });
  }
  save();
  render();
});

$('list-clear-done').addEventListener('click', () => {
  state.list = state.list.filter((l) => !l.done);
  save();
  render();
});

$('list-clear').addEventListener('click', () => {
  if (!confirm('Svuotare la lista? I prodotti già nello scontrino restano.')) return;
  state.list = [];
  save();
  render();
});

$('list-link').addEventListener('click', () => showView('lista'));

// short fade-out before a row disappears
function removeRow(li, mutate) {
  const finish = () => { mutate(); save(); render(); };
  if (!li || reduceMotion()) return finish();
  li.classList.add('leaving');
  setTimeout(finish, 180);
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

function addToCart(name, price, qty, barcode, meta, fromList) {
  let item = state.cart.find((x) => x.price === price && x.name === name && (x.barcode || null) === (barcode || null));
  if (item) item.qty += qty;
  else state.cart.push(item = { id: uid(), name, price, qty, barcode: barcode || null });
  lastAddedId = item.id;
  remember(name, price, barcode, meta);
  // bought something that is on the shopping list (scan, chip, manual): tick it off
  if (!fromList) {
    const li = findListMatch(name, barcode);
    if (li) { li.done = true; li.cartId = item.id; li.added = qty; li.key = catalogKey(name, barcode); }
  }
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
    if (keep) setCartPrice(it, price);
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

function setCartPrice(it, price) {
  if (!Number.isFinite(price) || price <= 0 || price === it.price) return;
  it.price = price;
  updateCatalogPrice(it.name, it.barcode, price);
  const twin = state.cart.find((x) => x !== it && x.price === price && x.name === it.name && (x.barcode || null) === (it.barcode || null));
  if (twin) {
    twin.qty += it.qty;
    state.cart = state.cart.filter((x) => x !== it);
    state.list.forEach((l) => { if (l.cartId === it.id) l.cartId = twin.id; });
  }
  lastAddedId = twin ? twin.id : it.id;
  save();
  toast(`Prezzo aggiornato: ${euro(price)}`);
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
function showView(view) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'impostazioni') renderSettings();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.view)));

// ---------- theme ----------
function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#111513' : '#f4f5f2');
  document.querySelectorAll('#theme-picker button').forEach((b) => {
    const on = b.dataset.theme === (t || 'auto');
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
}
$('theme-picker').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]');
  if (!b) return;
  state.settings.theme = b.dataset.theme;
  save();
  applyTheme();
});
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', applyTheme);
}

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
  } else if (action === 'list') {
    addToList('', key);
    toast(`${productLabel(c)} aggiunto alla lista`);
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
  if (btn.dataset.act === 'del') {
    return removeRow(btn.closest('.item'), () => { state.cart = state.cart.filter((x) => x.id !== id); });
  }
  lastAddedId = it.qty > 0 && state.cart.includes(it) ? it.id : null;
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
  const ticked = state.list.filter((l) => l.done).length;
  const msg = `Concludere la spesa?\n\nTotale ${euro(total)}\nBuoni: ${r.used} (${euro(r.used * r.value)})\nA parte: ${euro(r.cash)}` +
    (ticked ? `\n\nI ${ticked} prodotti spuntati escono dalla lista.` : '');
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
  state.list = state.list.filter((l) => !l.done); // what was not found stays for next time
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
  if (!confirm('Cancellare impostazioni, spesa in corso, lista e storico?')) return;
  localStorage.removeItem(STORE_KEY);
  state = structuredClone(DEFAULTS);
  applyTheme();
  renderSettings();
  render();
});

function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => { el.hidden = true; }, 1500);
}

applyTheme();
render();

// the list's mini receipt sticks just under the header
function measureHeader() {
  document.documentElement.style.setProperty('--header-h', document.querySelector('.top').offsetHeight + 'px');
}
measureHeader();
window.addEventListener('resize', measureHeader);

// ---------- offline + updates ----------
// The service worker keeps a copy of the app so it opens in the store without signal.
// Each release has its own cache version: when a new one is published, it downloads
// in the background and the app reloads itself onto it (only when you are not typing).
if ('serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  let pendingReload = false;
  const busy = () => {
    const a = document.activeElement;
    return (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) || $('prod-dialog').open || !$('scanner').hidden;
  };
  const reloadNow = () => {
    try { sessionStorage.setItem('cf-updated', '1'); } catch (e) { /* ignore */ }
    location.reload();
  };
  sw.addEventListener('controllerchange', () => {
    if (!hadController || pendingReload) return; // first install: nothing to refresh
    pendingReload = true;
    if (!busy()) reloadNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingReload) reloadNow();
  });
  document.addEventListener('focusout', () => setTimeout(() => { if (pendingReload && !busy()) reloadNow(); }, 300));
  window.addEventListener('load', () => {
    sw.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      // reopening the app from the home screen checks for a new version
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

try {
  if (sessionStorage.getItem('cf-updated')) {
    sessionStorage.removeItem('cf-updated');
    toast('App aggiornata all\'ultima versione ✓');
  }
} catch (e) { /* ignore */ }

if (window.caches) {
  caches.keys().then((keys) => {
    const k = keys.filter((x) => x.startsWith('cashfresh-')).sort().pop();
    if (k) $('app-version').textContent = 'Versione ' + k.replace('cashfresh-', '') + ' · funziona anche offline';
  }).catch(() => {});
}
