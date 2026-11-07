'use strict';

const STORE_KEY = 'cashfresh:v1';

const DEFAULTS = {
  settings: { value: 1100, maxPerTrip: 8, wallet: 20, monthly: 20, online: true, theme: 'dark', ui2: true,
    stores: ['Conad', 'Lidl', 'Esselunga'], store: '', haptics: true }, // amounts in cents
  // receipt line: { id, name, price (cents, per kg when kg), qty, barcode,
  //   kg (sold by weight), grams, deal: { t: '2x1'|'3x2'|'pct'|'price', v }, r (receipt 0 or 1) }
  cart: [],
  split: false,  // two receipts in the same trip, each with its own vouchers
  addTo: 0,      // receipt that gets new products while split
  list: [],      // shopping list: { id, name, qty, key (catalog key or null), done, cartId, added }
  history: [],   // { id, date, total, vouchers, voucherValue, cash, items }
  cards: [],     // loyalty cards: { id, chain (id in CHAINS or ''), name, number, format, bg, fg, logo (data URL), added, used }
  catalog: {}    // key -> { name, brand, quantity, image, barcode, unit ('kg' or none), price (last seen anywhere),
                 //          storePrices: { store: { p, d } }, prices: [{ p, d, s }], used, count }
};

let pendingBarcode = null;
let pendingMeta = null;   // brand/image found online for the barcode being added

let state = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && raw.settings) {
      const settings = { ...DEFAULTS.settings, ...raw.settings };
      // new home (Nov 2026): the dark look becomes the default once; light/auto stay available
      if (!raw.settings.ui2) {
        if (!settings.theme || settings.theme === 'auto') settings.theme = 'dark';
        settings.ui2 = true;
      }
      return {
        settings,
        cart: Array.isArray(raw.cart) ? raw.cart : [],
        list: Array.isArray(raw.list) ? raw.list : [],
        history: Array.isArray(raw.history) ? raw.history : [],
        catalog: raw.catalog && typeof raw.catalog === 'object' ? raw.catalog : {},
        cards: Array.isArray(raw.cards) ? raw.cards : [],
        split: !!raw.split,
        addTo: raw.addTo === 1 ? 1 : 0
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

// ---------- line totals: weight and offers ----------
const byWeight = (it) => it.kg === true;
const gramsLabel = (g) => g >= 1000 ? (g / 1000).toLocaleString('it-IT', { maximumFractionDigits: 3 }) + ' kg' : g + ' g';
const perKg = (cents, g) => Math.round((cents * g) / 1000);

// what the line would cost without the offer
function lineFull(it) {
  return byWeight(it) ? perKg(it.price, it.grams || 0) : it.price * it.qty;
}

// what the line really costs
function lineTotal(it) {
  const d = it.deal;
  if (!d) return lineFull(it);
  if (d.t === 'price') return byWeight(it) ? perKg(d.v, it.grams || 0) : d.v * it.qty;
  if (d.t === 'pct') return Math.round((lineFull(it) * (100 - d.v)) / 100);
  if ((d.t === '2x1' || d.t === '3x2') && !byWeight(it)) {
    const n = d.t === '2x1' ? 2 : 3;
    return it.price * (it.qty - Math.floor(it.qty / n));
  }
  return lineFull(it);
}

function dealLabel(d) {
  if (!d) return '';
  if (d.t === 'pct') return `−${d.v}%`;
  if (d.t === 'price') return 'in offerta';
  return d.t;
}

// ---------- rendering ----------
function cartTotal() {
  return state.cart.reduce((sum, it) => sum + lineTotal(it), 0);
}

function render() {
  syncList();
  renderStores();
  renderCart();
  renderList();
  renderRecent();
  renderCatalog();
  renderSummary();
  renderHistory();
  if (typeof renderHome === 'function') renderHome();
}

// ---------- one or two receipts ----------
function receiptTotal(r) {
  return state.cart.reduce((sum, it) => sum + ((it.r || 0) === r ? lineTotal(it) : 0), 0);
}

// Each receipt has its own voucher limit; the second one can only use the vouchers left in the wallet.
function receiptsInfo() {
  const s = state.settings;
  if (!state.split) {
    const total = cartTotal();
    return [{ total, r: computeSplit(total, s) }];
  }
  const t0 = receiptTotal(0), t1 = receiptTotal(1);
  const r0 = computeSplit(t0, s);
  const r1 = computeSplit(t1, { ...s, wallet: Math.max(0, s.wallet - r0.used) });
  return [{ total: t0, r: r0 }, { total: t1, r: r1 }];
}

// Best way to put the receipt lines on two receipts: fewest euro paid apart.
// Subset sums over the line totals (cents), so it is exact and fast enough for a supermarket trip.
function proposeSplit() {
  const s = state.settings;
  const lines = state.cart.map(lineTotal);
  const T = lines.reduce((a, b) => a + b, 0);
  if (lines.length < 2 || T <= 0 || T > 200000 || s.value <= 0) return null;
  const from = new Int32Array(T + 1).fill(-1);
  const reach = new Uint8Array(T + 1);
  reach[0] = 1;
  lines.forEach((w, i) => {
    if (w <= 0) return;
    for (let t = T; t >= w; t--) if (!reach[t] && reach[t - w]) { reach[t] = 1; from[t] = i; }
  });
  let best = null;
  for (let t = 1; t < T; t++) {
    if (!reach[t]) continue;
    const a = computeSplit(t, s);
    const b = computeSplit(T - t, { ...s, wallet: Math.max(0, s.wallet - a.used) });
    const cash = a.cash + b.cash;
    // fewer euro apart; then receipt 1 paid fully with vouchers; then receipt 1 fuller
    if (!best || cash < best.cash || (cash === best.cash && (a.cash < best.cash0 || (a.cash === best.cash0 && t > best.t)))) {
      best = { t, cash, cash0: a.cash, vouchers: a.used + b.used };
    }
  }
  if (!best) return null;
  const first = new Set();
  for (let t = best.t; t > 0; t -= lines[from[t]]) first.add(from[t]);
  best.first = first;
  return best;
}

let limitLevel = null; // 0 fine, 1 close to the limit, 2 over: a change upward gives a haptic tap

function renderSummary() {
  const total = cartTotal();
  const s = state.settings;
  const recs = receiptsInfo();
  const used = recs.reduce((a, x) => a + x.r.used, 0);
  const cash = recs.reduce((a, x) => a + x.r.cash, 0);
  const value = s.value;
  const single = recs[0].r;
  const isOver = (x) => x.total > x.r.limit;
  const isNear = (x) => x.r.limit > 0 && x.total >= x.r.limit * 0.9 && x.total <= x.r.limit;
  const over = recs.some(isOver);
  // with two receipts a full receipt 1 is the goal, so only "over" colours the whole box
  const near = !over && !state.split && recs.some(isNear);

  countTo($('total'), total);
  $('vouchers-used').textContent = used;
  $('vouchers-amount').textContent = euro(used * value);
  countTo($('cash-due'), cash);
  countTo($('l-total'), total);
  $('l-vouchers').textContent = used;
  countTo($('l-cash'), cash);

  // single receipt: one bar; two receipts: one small bar each
  paintBar($('bar-fill'), $('bar-ticks'), total, single);
  paintBar($('l-bar-fill'), $('l-bar-ticks'), state.split ? recs[0].total + recs[1].total : total,
    state.split ? { ...single, limit: recs[0].r.limit + recs[1].r.limit, cap: 0 } : single);
  ['summary', 'mini-summary'].forEach((box) => {
    $(box).classList.toggle('over', over);
    $(box).classList.toggle('at-limit', near);
  });
  $('summary').classList.toggle('two', state.split);
  $('bar-caption').textContent = single.limit > 0
    ? `${euro(total)} su ${euro(single.limit)} coperti dai buoni (${single.cap} × ${euro(single.value)})`
    : 'Nessun buono disponibile';

  renderReceipts(recs, isOver, isNear);

  // too much for one receipt: offer two
  let offer = null;
  if (!state.split && total > single.limit && single.cap > 0) {
    const p = proposeSplit();
    if (p && p.cash < single.cash) offer = p;
  }
  $('split-offer').hidden = !offer;
  if (offer) {
    $('split-offer-text').innerHTML = `Con <strong>due scontrini</strong> usi ${offer.vouchers} buoni e paghi a parte <strong>${euro(offer.cash)}</strong> invece di ${euro(single.cash)}.`;
    splitOffer = offer;
  } else splitOffer = null;

  let hint;
  if (state.split) {
    const [a, b] = recs;
    if (b.total === 0) hint = 'Scontrino 2 vuoto: tocca un prodotto ↔ per spostarlo, oppure aggiungi qui sotto (va nello scontrino evidenziato).';
    else if (over) hint = `Uno scontrino supera il limite dei buoni: sposta qualche prodotto con ↔. Buoni rimasti dopo lo scontrino 1: ${Math.max(0, s.wallet - a.r.used)}.`;
    else hint = 'Alla cassa fai due scontrini: prima i prodotti dello scontrino 1, poi quelli del 2.';
  } else if (single.cap === 0) {
    hint = s.wallet === 0
      ? 'Hai finito i buoni. Aggiornali in Opzioni quando arrivano quelli nuovi.'
      : 'Controlla le impostazioni dei buoni.';
  } else if (total === 0) {
    hint = `Puoi spendere fino a ${euro(single.limit)} usando ${single.cap} buoni.`;
  } else if (total > single.limit) {
    const why = s.wallet < s.maxPerTrip ? `ti restano solo ${s.wallet} buoni` : `il massimo è ${s.maxPerTrip} buoni per spesa`;
    hint = `Hai superato il limite dei buoni di ${euro(total - single.limit)}: ${why}.`;
  } else if (total === single.limit) {
    hint = 'Perfetto: usi tutti i buoni possibili senza pagare nulla a parte.';
  } else if (single.remainder === 0) {
    hint = `Cifra esatta: ${single.used} buoni, niente da pagare a parte.`;
  } else {
    hint = `Aggiungi ancora ${euro(single.toNext)} di spesa per sfruttare un altro buono intero.`;
  }
  $('hint').textContent = hint;

  const level = over ? 2 : near ? 1 : 0;
  if (limitLevel !== null && level > limitLevel) haptic(level === 2 ? 3 : 2);
  limitLevel = level;
}

let splitOffer = null;

function renderReceipts(recs, isOver, isNear) {
  const wrap = $('receipts-wrap');
  wrap.hidden = !state.split;
  if (!state.split) return;
  $('receipts').innerHTML = recs.map((x, i) => {
    const pct = x.r.limit > 0 ? Math.min(100, (x.total / x.r.limit) * 100) : 100;
    const cls = ['rcpt', state.addTo === i ? 'active' : '', isOver(x) ? 'over' : isNear(x) ? 'at-limit' : ''].join(' ');
    return `<button type="button" class="${cls}" data-r="${i}" aria-pressed="${state.addTo === i}">
      <span class="rcpt-head"><strong>Scontrino ${i + 1}</strong><span>${euro(x.total)}</span></span>
      <span class="bar"><span class="bar-fill" style="transform:scaleX(${pct / 100})"></span></span>
      <span class="rcpt-sub">${x.r.used} ${x.r.used === 1 ? 'buono' : 'buoni'} · ${euro(x.r.cash)} a parte</span>
      <span class="rcpt-add">${state.addTo === i ? '✓ aggiungi qui' : 'tocca per aggiungere qui'}</span>
    </button>`;
  }).join('');
}

// Progress bar toward the voucher limit, with one notch per voucher.
function paintBar(fill, ticks, total, r) {
  const pct = r.limit > 0 ? Math.min(100, (total / r.limit) * 100) : 100;
  fill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
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

function cartLineHtml(it) {
  const kg = byWeight(it);
  const full = lineFull(it);
  const tot = lineTotal(it);
  const unit = kg
    ? `${euro(it.price)}/kg`
    : `${euro(it.price)}${it.qty > 1 ? ' cad.' : ''}`;
  const deal = it.deal
    ? `<button type="button" class="deal on" data-act="deal" aria-label="Cambia offerta">${escapeHtml(dealLabel(it.deal))}${full > tot ? ` · −${euro(full - tot)}` : ''}</button>`
    : '<button type="button" class="deal" data-act="deal" aria-label="Aggiungi offerta">% offerta</button>';
  const move = state.split
    ? `<button type="button" class="move" data-act="move" aria-label="Sposta nell'altro scontrino">↔ ${(it.r || 0) === 0 ? 2 : 1}</button>`
    : '';
  const qty = kg
    ? `<div class="item-qty"><button type="button" class="grams" data-act="grams" aria-label="Cambia peso">${gramsLabel(it.grams || 0)}</button></div>`
    : `<div class="item-qty">
        <button data-act="dec" aria-label="Meno">−</button>
        <span>${it.qty}</span>
        <button data-act="inc" aria-label="Più">+</button>
      </div>`;
  return `
      <div class="item-main">
        <span class="item-name">${it.name ? escapeHtml(it.name) : '<span class="muted">Prodotto</span>'}</span>
        <span class="item-tags">
          <button type="button" class="item-unit" data-act="price" aria-label="Cambia prezzo">${unit} <span class="pencil">✎</span></button>
          ${deal}${move}
        </span>
      </div>
      ${qty}
      <span class="item-total">${full > tot ? `<s>${euro(full)}</s>` : ''}${euro(tot)}</span>
      <button class="item-del" data-act="del" aria-label="Elimina">✕</button>`;
}

function renderCart() {
  const list = $('items');
  list.innerHTML = '';
  const groups = state.split ? [0, 1] : [null];
  groups.forEach((g) => {
    const rows = [...state.cart].reverse().filter((it) => g === null || (it.r || 0) === g); // newest first
    if (g !== null) {
      const h = document.createElement('li');
      h.className = 'receipt-group';
      h.innerHTML = `<span>Scontrino ${g + 1}</span><strong>${euro(receiptTotal(g))}</strong>`;
      list.appendChild(h);
      if (!rows.length) {
        const e = document.createElement('li');
        e.className = 'empty';
        e.textContent = 'Nessun prodotto in questo scontrino.';
        list.appendChild(e);
      }
    }
    rows.forEach((it) => {
      const li = document.createElement('li');
      li.className = 'item' + (it.id === lastAddedId ? ' enter' : '') + (it.deal ? ' has-deal' : '');
      li.dataset.id = it.id;
      li.innerHTML = cartLineHtml(it);
      list.appendChild(li);
    });
  });
  const empty = state.cart.length === 0;
  $('empty').hidden = !empty;
  $('receipt-title').hidden = empty || state.split;
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
      <div class="trip-sub">${h.store ? escapeHtml(h.store) + ' · ' : ''}${h.part ? `scontrino ${h.part} di 2 · ` : ''}${h.vouchers} buoni (${euro(h.vouchers * h.voucherValue)}) · ${euro(h.cash)} a parte · ${h.items.length} prodotti</div>
      <button class="ghost small danger" data-del="${h.id}">Elimina</button>`;
    list.appendChild(li);
  });
  $('history-empty').hidden = state.history.length > 0;
}

// ---------- product database ----------
const catalogKey = (name, barcode) => barcode ? 'b:' + barcode : (name ? 'n:' + name.toLowerCase() : null);
const MAX_PRICES = 30;

const currentStore = () => {
  const st = state.settings.store;
  return st && (state.settings.stores || []).includes(st) ? st : '';
};

// A new price seen in the current store: it goes in the history, becomes the
// store's price and also the "last known price" used in stores without one.
function pushPrice(c, price, when) {
  const store = currentStore();
  if (!Array.isArray(c.prices)) c.prices = c.price ? [{ p: c.price, d: c.used || when }] : [];
  const last = c.prices[c.prices.length - 1];
  if (last && last.p === price && (last.s || '') === store) last.d = when;
  else c.prices.push(store ? { p: price, d: when, s: store } : { p: price, d: when });
  if (c.prices.length > MAX_PRICES) c.prices = c.prices.slice(-MAX_PRICES);
  if (store) {
    if (!c.storePrices || typeof c.storePrices !== 'object') c.storePrices = {};
    c.storePrices[store] = { p: price, d: when };
  }
}

// price to propose: the current store's own price, otherwise the last one seen anywhere
function priceFor(c) {
  const sp = storePrice(c);
  return sp ? sp.p : c.price;
}
function storePrice(c) {
  const st = currentStore();
  const sp = st && c && c.storePrices && c.storePrices[st];
  return sp && sp.p > 0 ? sp : null;
}
// "(ultimo prezzo visto)" when the current store has no price of its own yet
const fallbackNote = (c) => currentStore() && !storePrice(c) ? ' (ultimo prezzo visto)' : '';
const unitSuffix = (c) => c && c.unit === 'kg' ? '/kg' : '';

function remember(name, price, barcode, meta, kg) {
  const key = catalogKey(name, barcode);
  if (!key) return;
  const now = Date.now();
  const prev = state.catalog[key] || { count: 0 };
  const c = { ...prev, ...(meta || {}) };
  c.name = name || prev.name || '';
  c.barcode = barcode || null;
  if (kg) c.unit = 'kg'; else delete c.unit;
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
    b.innerHTML = `<span>${escapeHtml(productLabel(c))}</span><strong>${euro(priceFor(c))}${unitSuffix(c)}</strong>`;
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
    price: (a, b) => priceFor(a[1]) - priceFor(b[1])
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
      <span class="prod-price">${euro(priceFor(c))}${unitSuffix(c)}${storePrice(c) || !currentStore() ? '' : '<small>ultimo</small>'}</span>
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
  return c && priceFor(c) > 0 ? priceFor(c) : null;
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

const listByWeight = (l) => { const c = l.key && state.catalog[l.key]; return !!(c && c.unit === 'kg'); };

function tickItem(l, price, grams) {
  const c = l.key ? state.catalog[l.key] : null;
  const name = c ? c.name : l.name;
  const barcode = c ? c.barcode : null;
  const item = addToCart(name, price, grams ? 1 : l.qty, barcode, null, true, grams ? { grams } : null);
  l.done = true;
  l.cartId = item.id;
  l.added = grams ? 1 : l.qty;
  l.key = catalogKey(name, barcode);
  save();
  render();
  toast(`Preso: ${productLabel({ name, barcode })} · ${euro(grams ? perKg(price, grams) : price * l.qty)}`);
}

function untickItem(l) {
  const it = state.cart.find((x) => x.id === l.cartId);
  if (it) {
    it.qty -= byWeight(it) ? it.qty : (l.added || l.qty);
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
      sub = !it ? ''
        : byWeight(it)
          ? `<button type="button" class="item-unit" data-act="price" aria-label="Cambia prezzo al kg">${gramsLabel(it.grams)} × ${euro(it.price)}/kg = ${euro(lineTotal(it))} <span class="pencil">✎</span></button>`
          : `<button type="button" class="item-unit" data-act="price" aria-label="Cambia prezzo">${l.added > 1 ? l.added + ' × ' : ''}${euro(it.price)} <span class="pencil">✎</span></button>`;
    } else {
      const p = listPrice(l);
      sub = listByWeight(l)
        ? `<span class="li-sub">${p ? `${euro(p)}/kg · ` : ''}a peso: i grammi li scrivi quando lo prendi</span>`
        : `<span class="li-sub">${p ? `${l.qty > 1 ? l.qty + ' × ' : ''}${euro(p)}` : 'Prezzo da scrivere quando lo prendi'}</span>`;
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
  const known = todo.filter((l) => listPrice(l) && !listByWeight(l));
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
    b.innerHTML = `<span>${escapeHtml(productLabel(c))}</span><strong>${euro(priceFor(c))}${unitSuffix(c)}</strong>`;
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
      b.innerHTML = `<span>${escapeHtml(productLabel(c))}${c.brand ? ` <em>${escapeHtml(c.brand)}</em>` : ''}</span><strong>${euro(priceFor(c))}${unitSuffix(c)}</strong>`;
      box.appendChild(b);
    });
}

// Item with no known price: ask for it right in the list row.
// opts.grams asks the weight instead, opts.perKg says the price is per kg
function askListPrice(l, li, onPrice, opts) {
  const o = opts || {};
  const main = li.querySelector('.li-main');
  const old = main.querySelector('.li-sub, .item-unit, .unit-input');
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = o.grams ? 'numeric' : 'decimal';
  input.enterKeyHint = 'done';
  input.className = 'unit-input';
  input.placeholder = o.grams ? 'Grammi' : o.perKg ? 'Prezzo €/kg' : 'Prezzo €';
  input.setAttribute('aria-label', o.grams ? 'Grammi' : 'Prezzo');
  const cur = !o.grams && state.cart.find((x) => x.id === l.cartId);
  if (cur) input.value = fmtPriceInput(cur.price);
  if (old) old.replaceWith(input); else main.appendChild(input);
  input.focus();
  if (cur) input.select();
  let finished = false;
  const commit = (keep) => {
    if (finished) return;
    finished = true;
    const price = o.grams ? parseGrams(input.value) : parseEuro(input.value);
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
    if (listByWeight(l)) {
      const askGrams = (price) => askListPrice(l, li, (g) => tickItem(l, price, g), { grams: true });
      return p ? askGrams(p) : askListPrice(l, li, askGrams, { perKg: true });
    }
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

// A saved product goes on the receipt at the current store's price.
// Products sold by weight need the grams first: the add form is filled in and waits for them.
function addProduct(c) {
  if (c.unit === 'kg') { prefillWeight(c); return null; }
  return addToCart(c.name, priceFor(c), 1, c.barcode);
}

function prefillWeight(c) {
  showView('spesa');
  $('item-name').value = c.name || '';
  $('item-price').value = fmtPriceInput(priceFor(c));
  pendingBarcode = c.barcode || null;
  pendingMeta = null;
  $('barcode-note').hidden = true;
  setUnitMode('kg');
  $('item-grams').value = '';
  $('item-grams').focus();
  toast(`${productLabel(c)}: ${euro(priceFor(c))}/kg${fallbackNote(c)} · scrivi i grammi`);
}

// opts.grams: product sold by weight, price is per kg
function addToCart(name, price, qty, barcode, meta, fromList, opts) {
  const grams = opts && opts.grams > 0 ? Math.round(opts.grams) : 0;
  const r = state.split ? state.addTo : 0;
  let item = grams ? null : state.cart.find((x) => !byWeight(x) && (x.r || 0) === r && x.price === price && x.name === name && (x.barcode || null) === (barcode || null));
  if (item) item.qty += qty;
  else {
    item = { id: uid(), name, price, qty: grams ? 1 : qty, barcode: barcode || null };
    if (grams) { item.kg = true; item.grams = grams; }
    if (state.split) item.r = r;
    state.cart.push(item);
  }
  lastAddedId = item.id;
  remember(name, price, barcode, meta, !!grams);
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
  if (!it) return;
  inlineEdit(id, '.item-unit', fmtPriceInput(it.price), 'decimal', byWeight(it) ? 'Nuovo prezzo al kg' : 'Nuovo prezzo',
    (v) => setCartPrice(it, parseEuro(v)));
}

// weight of a line sold by weight
function startGramsEdit(id) {
  const it = state.cart.find((x) => x.id === id);
  if (!it) return;
  inlineEdit(id, '.grams', String(it.grams || ''), 'numeric', 'Grammi', (v) => {
    const g = parseGrams(v);
    if (g > 0 && g !== it.grams) { it.grams = g; lastAddedId = it.id; save(); }
  });
}

function inlineEdit(id, selector, value, mode, label, apply) {
  const li = document.querySelector(`.item[data-id="${id}"]`);
  const btn = li && li.querySelector(selector);
  if (!btn) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = mode;
  input.enterKeyHint = 'done';
  input.className = 'unit-input';
  input.value = value;
  input.setAttribute('aria-label', label);
  btn.replaceWith(input);
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  input.focus();
  input.select();
  let done = false;
  const commit = (keep) => {
    if (done) return;
    done = true;
    if (keep) apply(input.value);
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// "450", "450 g", "0,45 kg", "1,2kg" -> grams
function parseGrams(str) {
  const t = String(str || '').trim().toLowerCase().replace(',', '.').replace(/\s/g, '');
  const m = t.match(/^(\d*\.?\d+)(g|gr|kg)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  return Math.round(m[2] === 'kg' ? n * 1000 : n);
}

function setCartPrice(it, price) {
  if (!Number.isFinite(price) || price <= 0 || price === it.price) return;
  it.price = price;
  updateCatalogPrice(it.name, it.barcode, price);
  const twin = !byWeight(it) && state.cart.find((x) => x !== it && !byWeight(x) && (x.r || 0) === (it.r || 0) && !x.deal === !it.deal &&
    x.price === price && x.name === it.name && (x.barcode || null) === (it.barcode || null));
  if (twin) {
    twin.qty += it.qty;
    state.cart = state.cart.filter((x) => x !== it);
    state.list.forEach((l) => { if (l.cartId === it.id) l.cartId = twin.id; });
  }
  lastAddedId = twin ? twin.id : it.id;
  save();
  toast(`Prezzo aggiornato: ${euro(price)}${byWeight(it) ? '/kg' : ''}${currentStore() ? ' da ' + currentStore() : ''}`);
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
  $('s-haptics').checked = s.haptics !== false;
}

// ---------- events ----------
// Every screen lives in the bottom sheet over the home: showing one also slides the sheet up.
let currentView = 'spesa';
function showView(view, keepClosed) {
  const changed = view !== currentView;
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'impostazioni') renderSettings();
  if (changed) $('bs-body').scrollTop = 0;
  if (typeof sheetShows === 'function') sheetShows(view, keepClosed);
}

// ---------- theme ----------
function applyTheme() {
  const t = state.settings.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#251d36' : '#e8dff4');
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
  let grams = 0;
  if (unitMode === 'kg') {
    grams = parseGrams($('item-grams').value);
    if (!(grams > 0)) {
      $('item-grams').classList.add('invalid');
      $('item-grams').focus();
      return;
    }
  }
  addToCart($('item-name').value.trim(), price, qty, pendingBarcode, pendingMeta, false, grams ? { grams } : null);
  clearPendingBarcode();
  $('item-name').value = '';
  $('item-price').value = '';
  $('item-qty').value = 1;
  $('item-grams').value = '';
  setUnitMode('pz');
  $('item-price').focus();
});

// typing a known product name fills in its last price
$('item-name').addEventListener('change', () => {
  const c = findByName($('item-name').value.trim());
  if (c && !$('item-price').value) {
    $('item-price').value = fmtPriceInput(priceFor(c));
    setUnitMode(c.unit === 'kg' ? 'kg' : 'pz');
  }
});

$('recent').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const c = state.catalog[b.dataset.key];
  if (c) addProduct(c);
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
let scanMode = 'cart'; // 'cart' adds to the trip, 'catalog' opens the product editor, 'card' reads a loyalty card
let scanDone = null;   // 'card' mode: called with (code, format)

// loyalty cards also use QR codes and older 1D formats; products only use EAN/UPC/Code 128
const SCAN_BASE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
const SCAN_CARD = SCAN_BASE.concat(['code_39', 'itf', 'codabar', 'qr_code', 'data_matrix', 'pdf417', 'aztec']);
// detector / ZXing names -> names used to draw the code again (JsBarcode, or QR)
function normFormat(f) {
  const k = String(f || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({ ean13: 'EAN13', ean8: 'EAN8', upca: 'UPC', upce: 'UPCE', code128: 'CODE128', code39: 'CODE39',
    itf: 'ITF', codabar: 'codabar', qrcode: 'QR', qr: 'QR', upc: 'UPC' })[k] || '';
}

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

async function openScanner(mode, done) {
  scanMode = mode === 'catalog' || mode === 'card' ? mode : 'cart';
  scanDone = scanMode === 'card' ? done : null;
  const wanted = scanMode === 'card' ? SCAN_CARD : SCAN_BASE;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('La fotocamera non è disponibile su questo browser. Inserisci il prezzo a mano.');
    return;
  }
  const video = $('scan-video');
  $('scan-msg').textContent = scanMode === 'card' ? 'Inquadra il codice della carta' : 'Inquadra il codice a barre';
  $('scanner').hidden = false;
  const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
  try {
    if ('BarcodeDetector' in window) {
      let formats = wanted;
      try { const sup = await BarcodeDetector.getSupportedFormats(); formats = wanted.filter((f) => sup.includes(f)); } catch (e) { /* use all */ }
      const detector = new BarcodeDetector({ formats });
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      let alive = true;
      scanStop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); };
      const tick = async () => {
        if (!alive) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) return onBarcode(codes[0].rawValue, codes[0].format);
        } catch (e) { /* keep trying */ }
        setTimeout(tick, 150);
      };
      tick();
    } else {
      const ZX = await loadZxing();
      const hints = new Map();
      const zxNames = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128'].concat(scanMode === 'card' ? ['CODE_39', 'ITF', 'CODABAR', 'QR_CODE', 'DATA_MATRIX', 'PDF_417', 'AZTEC'] : []);
      hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, zxNames.map((n) => ZX.BarcodeFormat[n]).filter((v) => v !== undefined));
      const reader = new ZX.BrowserMultiFormatReader(hints, 200);
      scanStop = () => reader.reset();
      await reader.decodeFromConstraints(constraints, video, (result) => {
        if (result) onBarcode(result.getText(), ZX.BarcodeFormat[result.getBarcodeFormat()]);
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

function onBarcode(code, format) {
  if (!scanStop) return; // already handled
  haptic(1);
  closeScanner();
  if (scanMode === 'card') { const cb = scanDone; scanDone = null; if (cb) cb(code, normFormat(format)); return; }
  if (scanMode === 'catalog') return openEditor('b:' + code, code);
  const known = state.catalog['b:' + code];
  if (known) {
    const item = addProduct(known);
    if (item) toast(`${productLabel(known)}: ${euro(item.price)}${fallbackNote(known)} · tocca per cambiare prezzo`, () => startPriceEdit(item.id));
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
  $('pd-price').value = c ? fmtPriceInput(priceFor(c)) : '';
  $('pd-kg').checked = !!(c && c.unit === 'kg');
  paintEditorPriceLabel(c);
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

function paintEditorPriceLabel(c) {
  const st = currentStore();
  const kg = $('pd-kg').checked;
  $('pd-price-label').textContent = (kg ? 'Prezzo €/kg' : 'Prezzo €') + (st ? ` da ${st}` : '');
  $('pd-price-note').hidden = !(c && st && !storePrice(c));
  $('pd-price-note').textContent = `Non hai ancora un prezzo di ${st}: qui c'è l'ultimo visto. Salvando diventa il prezzo di ${st}.`;
}
$('pd-kg').addEventListener('change', () => paintEditorPriceLabel(editKey ? state.catalog[editKey] : null));

function renderPriceHistory(c) {
  const box = $('pd-history');
  const ps = c && Array.isArray(c.prices) ? c.prices : [];
  const sp = c && c.storePrices ? Object.entries(c.storePrices).filter(([, x]) => x && x.p > 0) : [];
  const day = (d) => new Date(d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  const u = unitSuffix(c);
  let html = '';
  if (sp.length) {
    html += '<span class="muted small-text">Prezzi per negozio</span><div class="ph-list stores">' +
      sp.sort((a, b) => a[1].p - b[1].p).map(([st, x]) => `<span class="${st === currentStore() ? 'here' : ''}">${escapeHtml(st)} <strong>${euro(x.p)}${u}</strong> ${day(x.d)}</span>`).join('') +
      '</div>';
  }
  if (ps.length >= 2) {
    html += '<span class="muted small-text">Prezzi visti</span><div class="ph-list">' +
      [...ps].reverse().slice(0, 8).map((x) => `<span><strong>${euro(x.p)}${u}</strong> ${day(x.d)}${x.s ? ' · ' + escapeHtml(x.s) : ''}</span>`).join('') +
      '</div>';
  }
  box.innerHTML = html;
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
  const proposed = prev || other ? priceFor(c) : null;
  if (proposed !== price || (currentStore() && !storePrice(c))) pushPrice(c, price, now);
  c.price = price;
  if ($('pd-kg').checked) c.unit = 'kg'; else delete c.unit;
  c.count = c.count || 0;
  c.used = c.used || now;
  if (editKey && editKey !== key) delete state.catalog[editKey];
  state.catalog[key] = c;
  save();
  dialog.close();
  if (action === 'cart') {
    if (addProduct(c)) toast(`${productLabel(c)} aggiunto: ${euro(c.price)}`);
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
    const item = addProduct(c);
    if (!item) return;
    toast(`${productLabel(c)} aggiunto: ${euro(item.price)}${fallbackNote(c)}`);
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
  if (!n && !state.cards.length) return alert('Non ci sono prodotti né carte da esportare.');
  const data = JSON.stringify({ app: 'cash-fresh', type: 'catalog', version: 2, exported: new Date().toISOString(), catalog: state.catalog, cards: state.cards }, null, 1);
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
    const hasCards = raw && Array.isArray(raw.cards);
    const n = hasCards && !raw.catalog ? 0 : importCatalog(raw && raw.catalog ? raw.catalog : raw);
    const m = hasCards ? importCards(raw.cards) : 0;
    save();
    render();
    renderCards();
    const parts = [];
    if (n) parts.push(`${n} ${n === 1 ? 'prodotto' : 'prodotti'}`);
    if (m) parts.push(`${m} ${m === 1 ? 'carta' : 'carte'}`);
    alert(parts.length ? `Importati ${parts.join(' e ')}.` : 'Niente di nuovo da importare nel file.');
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
      ? x.prices.filter((p) => p && Number.isFinite(p.p) && Number.isFinite(p.d))
        .map((p) => (typeof p.s === 'string' && p.s ? { p: Math.round(p.p), d: p.d, s: p.s.slice(0, 40) } : { p: Math.round(p.p), d: p.d }))
      : [];
    const storePrices = {};
    if (x.storePrices && typeof x.storePrices === 'object') {
      Object.entries(x.storePrices).forEach(([st, v]) => {
        if (st && v && Number.isFinite(v.p) && v.p > 0) storePrices[st.slice(0, 40)] = { p: Math.round(v.p), d: Number.isFinite(v.d) ? v.d : Date.now() };
      });
    }
    const inc = {
      name, barcode, price,
      brand: typeof x.brand === 'string' ? x.brand.slice(0, 80) : '',
      quantity: typeof x.quantity === 'string' ? x.quantity.slice(0, 40) : '',
      image: safeImg(x.image),
      prices,
      used: Number.isFinite(x.used) ? x.used : Date.now(),
      count: Number.isFinite(x.count) ? x.count : 0,
      storePrices
    };
    if (x.unit === 'kg') inc.unit = 'kg';
    const cur = state.catalog[key];
    if (cur) {
      const newer = (inc.used || 0) > (cur.used || 0) ? inc : cur;
      const seen = new Set();
      const merged = [...(cur.prices || []), ...prices]
        .sort((a, b) => a.d - b.d)
        .filter((p) => { const k = p.p + ':' + p.d; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(-MAX_PRICES);
      const sp = { ...(cur.storePrices || {}) };
      Object.entries(storePrices).forEach(([st, v]) => { if (!sp[st] || (sp[st].d || 0) < v.d) sp[st] = v; });
      state.catalog[key] = { ...cur, ...inc, ...newer, brand: newer.brand || cur.brand || inc.brand, image: newer.image || cur.image || inc.image, prices: merged, count: Math.max(cur.count || 0, inc.count), storePrices: sp };
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
  if (btn.dataset.act === 'grams') return startGramsEdit(id);
  if (btn.dataset.act === 'deal') return openDeal(it);
  if (btn.dataset.act === 'move') {
    it.r = (it.r || 0) === 0 ? 1 : 0;
    lastAddedId = it.id;
    save();
    render();
    return toast(`Spostato nello scontrino ${it.r + 1}`);
  }
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
  state.split = false;
  state.addTo = 0;
  save();
  render();
});

$('close-trip').addEventListener('click', () => {
  const recs = receiptsInfo();
  const ticked = state.list.filter((l) => l.done).length;
  const two = state.split && recs.every((x) => x.total > 0);
  const lines = recs.map((x, i) => (state.split ? `Scontrino ${i + 1}: ` : 'Totale ') +
    `${euro(x.total)}\nBuoni: ${x.r.used} (${euro(x.r.used * x.r.value)}) · a parte: ${euro(x.r.cash)}`);
  const msg = `Concludere la spesa?\n\n${lines.join('\n\n')}` +
    (ticked ? `\n\nI ${ticked} prodotti spuntati escono dalla lista.` : '');
  if (!confirm(msg)) return;
  const date = new Date().toISOString();
  const store = currentStore();
  recs.forEach((x, i) => {
    if (state.split && x.total === 0) return;
    const entry = {
      id: uid(),
      date,
      total: x.total,
      vouchers: x.r.used,
      voucherValue: x.r.value,
      cash: x.r.cash,
      items: state.cart.filter((it) => !state.split || (it.r || 0) === i)
    };
    if (store) entry.store = store;
    if (two) entry.part = i + 1;
    state.history.push(entry);
    state.settings.wallet = Math.max(0, state.settings.wallet - x.r.used);
  });
  state.cart = [];
  state.split = false;
  state.addTo = 0;
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
  if (!confirm('Cancellare impostazioni, spesa in corso, lista, storico, prodotti e carte fedeltà?')) return;
  localStorage.removeItem(STORE_KEY);
  state = structuredClone(DEFAULTS);
  applyTheme();
  renderSettings();
  render();
  renderCards();
});

function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => { el.hidden = true; }, 1500);
}

// ---------- two receipts ----------
$('split-do').addEventListener('click', () => {
  const p = splitOffer || proposeSplit();
  if (!p) return;
  state.cart.forEach((it, i) => { it.r = p.first.has(i) ? 0 : 1; });
  state.split = true;
  state.addTo = 1; // the first receipt is the full one: new products go on the second
  save();
  render();
  toast('Diviso in due scontrini');
});
$('split-manual').addEventListener('click', () => {
  state.cart.forEach((it) => { it.r = 0; });
  state.split = true;
  state.addTo = 1;
  save();
  render();
});
$('receipts').addEventListener('click', (e) => {
  const b = e.target.closest('.rcpt');
  if (!b) return;
  state.addTo = b.dataset.r === '1' ? 1 : 0;
  save();
  render();
});
$('split-undo').addEventListener('click', () => {
  state.split = false;
  state.addTo = 0;
  state.cart.forEach((it) => { delete it.r; });
  // the same product on both receipts becomes one line again
  const merged = [];
  state.cart.forEach((it) => {
    const twin = !byWeight(it) && merged.find((x) => !byWeight(x) && x.price === it.price && x.name === it.name &&
      (x.barcode || null) === (it.barcode || null) && JSON.stringify(x.deal || null) === JSON.stringify(it.deal || null));
    if (twin) {
      twin.qty += it.qty;
      state.list.forEach((l) => { if (l.cartId === it.id) l.cartId = twin.id; });
    } else merged.push(it);
  });
  state.cart = merged;
  save();
  render();
});

// ---------- offers ----------
let dealItem = null;
let dealType = '';

function openDeal(it) {
  dealItem = it;
  dealType = it.deal ? it.deal.t : '';
  $('deal-title').textContent = it.name || 'Prodotto';
  const kg = byWeight(it);
  $('deal-types').querySelectorAll('[data-deal="2x1"], [data-deal="3x2"]').forEach((b) => { b.hidden = kg; });
  $('deal-value').value = it.deal && it.deal.t === 'pct' ? String(it.deal.v)
    : it.deal && it.deal.t === 'price' ? fmtPriceInput(it.deal.v) : '';
  paintDeal();
  $('deal-dialog').showModal();
}

function readDeal() {
  if (!dealType) return null;
  if (dealType === '2x1' || dealType === '3x2') return { t: dealType };
  const raw = $('deal-value').value;
  if (dealType === 'pct') {
    const v = parseFloat(String(raw).replace(',', '.').replace('%', ''));
    return v > 0 && v < 100 ? { t: 'pct', v: Math.round(v * 10) / 10 } : undefined;
  }
  const v = parseEuro(raw);
  return v > 0 && v < dealItem.price ? { t: 'price', v } : undefined;
}

function paintDeal() {
  $('deal-types').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.deal === dealType));
  const needsValue = dealType === 'pct' || dealType === 'price';
  $('deal-value-field').hidden = !needsValue;
  $('deal-value-label').textContent = dealType === 'pct' ? 'Sconto %' : byWeight(dealItem) ? 'Prezzo scontato al kg €' : 'Prezzo scontato €';
  $('deal-value').placeholder = dealType === 'pct' ? 'Es. 30' : 'Es. ' + fmtPriceInput(Math.round(dealItem.price * 0.7));
  const d = readDeal();
  const it = dealItem;
  let txt = '';
  if (d === undefined) txt = dealType === 'price' ? `Scrivi un prezzo più basso di ${euro(it.price)}.` : 'Scrivi lo sconto (da 1 a 99).';
  else {
    const probe = { ...it, deal: d };
    const full = lineFull(probe), tot = lineTotal(probe);
    txt = d ? `${euro(full)} → <strong>${euro(tot)}</strong>${full > tot ? ` · risparmi ${euro(full - tot)}` : ''}` : `Prezzo pieno: ${euro(full)}`;
    if (d && (d.t === '2x1' || d.t === '3x2') && !byWeight(it)) {
      const n = d.t === '2x1' ? 2 : 3;
      if (it.qty < n) txt += `<br>Con ${it.qty} pezzo non c'è sconto: ne servono ${n}.`;
    }
  }
  $('deal-preview').innerHTML = txt;
}

$('deal-types').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-deal]');
  if (!b) return;
  dealType = b.dataset.deal;
  paintDeal();
  if (dealType === 'pct' || dealType === 'price') $('deal-value').focus();
});
$('deal-value').addEventListener('input', paintDeal);
$('deal-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const action = e.submitter ? e.submitter.value : 'save';
  if (action !== 'save') return $('deal-dialog').close();
  const d = readDeal();
  if (d === undefined) { $('deal-value').classList.add('invalid'); $('deal-value').focus(); return; }
  $('deal-value').classList.remove('invalid');
  if (d) dealItem.deal = d; else delete dealItem.deal;
  lastAddedId = dealItem.id;
  $('deal-dialog').close();
  save();
  render();
});

// ---------- weight ----------
let unitMode = 'pz';
function setUnitMode(m) {
  unitMode = m === 'kg' ? 'kg' : 'pz';
  document.querySelectorAll('#unit-toggle button').forEach((b) => {
    const on = b.dataset.unit === unitMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  $('price-label').textContent = unitMode === 'kg' ? 'Prezzo €/kg' : 'Prezzo €';
  $('qty-field').hidden = unitMode === 'kg';
  $('grams-field').hidden = unitMode !== 'kg';
  paintWeightCalc();
}
function paintWeightCalc() {
  const el = $('weight-calc');
  const p = parseEuro($('item-price').value);
  const g = parseGrams($('item-grams').value);
  const show = unitMode === 'kg' && p > 0 && g > 0;
  el.hidden = !show;
  if (show) el.textContent = `${gramsLabel(g)} × ${euro(p)}/kg = ${euro(perKg(p, g))}`;
}
$('unit-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-unit]');
  if (!b) return;
  setUnitMode(b.dataset.unit);
  if (unitMode === 'kg' && $('item-price').value) $('item-grams').focus();
});
$('item-grams').addEventListener('input', (e) => { e.target.classList.remove('invalid'); paintWeightCalc(); });
$('item-price').addEventListener('input', paintWeightCalc);

// ---------- stores ----------
function renderStores() {
  const s = state.settings;
  const stores = s.stores || [];
  const sel = $('store-select');
  sel.innerHTML = '<option value="">Nessun negozio</option>' +
    stores.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('') +
    '<option value="__edit">Modifica negozi…</option>';
  sel.value = currentStore();
  $('store-list').innerHTML = stores.map((x) =>
    `<span class="store-chip">${escapeHtml(x)}<button type="button" data-del-store="${escapeHtml(x)}" aria-label="Togli ${escapeHtml(x)}">✕</button></span>`).join('') ||
    '<span class="muted small-text">Nessun negozio.</span>';
  if (typeof paintStoreCard === 'function') paintStoreCard();
}
$('store-select').addEventListener('change', (e) => {
  if (e.target.value === '__edit') {
    e.target.value = currentStore();
    showView('impostazioni');
    $('store-new').focus();
    return;
  }
  state.settings.store = e.target.value;
  save();
  render();
  const card = state.settings.store && typeof cardForStore === 'function' ? cardForStore(state.settings.store) : null;
  if (card) toast(`Prezzi di ${state.settings.store} · tocca per la carta`, () => openCard(card.id));
  else if (state.settings.store) toast(`Prezzi di ${state.settings.store}`);
});
$('store-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('store-new').value.trim().slice(0, 40);
  if (!name) return;
  const stores = state.settings.stores || (state.settings.stores = []);
  if (!stores.some((x) => x.toLowerCase() === name.toLowerCase())) stores.push(name);
  $('store-new').value = '';
  save();
  render();
});
$('store-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-del-store]');
  if (!b) return;
  const name = b.dataset.delStore;
  if (!confirm(`Togliere ${name} dall'elenco? I prezzi già salvati restano nei prodotti.`)) return;
  state.settings.stores = (state.settings.stores || []).filter((x) => x !== name);
  if (state.settings.store === name) state.settings.store = '';
  save();
  render();
});

// ---------- haptic feedback ----------
// navigator.vibrate where it exists (Android). Safari on iPhone has no vibration API:
// from iOS 18 toggling an <input switch> gives a light system tap, which works only
// while handling a touch. Elsewhere it silently does nothing.
const haptic = (() => {
  let label = null;
  const el = () => {
    if (label) return label;
    label = document.createElement('label');
    label.className = 'haptic';
    label.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    return label;
  };
  return (pulses = 1) => {
    if (state.settings.haptics === false) return;
    try {
      if (navigator.vibrate) { navigator.vibrate(pulses === 1 ? 40 : Array.from({ length: pulses * 2 - 1 }, (_, i) => (i % 2 ? 70 : 45))); return; }
      const l = el();
      l.click(); // first tap right away, while the touch still counts
      for (let k = 1; k < pulses; k++) setTimeout(() => l.click(), k * 120);
    } catch (e) { /* no haptics here */ }
  };
})();
$('s-haptics').addEventListener('change', (e) => {
  state.settings.haptics = e.target.checked;
  save();
  if (e.target.checked) haptic(1);
});

applyTheme();
render();


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
    return (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) || $('prod-dialog').open || $('deal-dialog').open || !$('scanner').hidden || !$('card-view').hidden || !$('card-edit').hidden;
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
