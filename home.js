'use strict';
// Home screen and bottom sheet.
//
// The home shows the two numbers that matter in the shop (vouchers used, euro to pay
// apart), round quick actions and one row per section. Every section (receipt, list,
// cards, products, history, options) opens in a sheet that slides up over the home and
// is dragged down by its handle to close. When closed, the sheet's top edge stays at the
// bottom of the screen as a peek of the receipt: drag it up or tap it to open the receipt.

const VIEW_TITLES = {
  spesa: 'Scontrino virtuale', lista: 'Lista della spesa', carte: 'Carte fedeltà',
  prodotti: 'Prodotti', storico: 'Storico', impostazioni: 'Opzioni'
};

const sheet = $('bsheet');
const sheetHead = $('bs-head');
const sheetBody = $('bs-body');
const root = document.documentElement;
let sheetOpen = false;
let sheetY = 0;       // current offset from the open position, in px
let closedY = 0;      // offset when only the peek shows

// ---------- home content ----------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderHome() {
  const s = state.settings;
  const recs = receiptsInfo();
  const total = cartTotal();
  const used = recs.reduce((a, x) => a + x.r.used, 0);
  const cash = recs.reduce((a, x) => a + x.r.cash, 0);
  const cap = recs.reduce((a, x) => a + x.r.cap, 0);

  $('h-vouchers').textContent = used;
  $('h-vouchers-of').textContent = `di ${cap}`;
  $('h-vouchers-eur').textContent = euro(used * s.value);
  countTo($('h-cash'), cash);
  $('h-total').textContent = `Spesa ${euro(total)}`;
  const single = recs[0].r;
  paintBar($('h-bar-fill'), $('h-bar-ticks'), total,
    state.split ? { ...single, limit: recs[0].r.limit + recs[1].r.limit, cap } : single);
  const sum = $('summary');
  $('hero').parentElement.classList.toggle('over', sum.classList.contains('over'));
  $('hero').parentElement.classList.toggle('at-limit', sum.classList.contains('at-limit'));
  $('h-hint').textContent = $('hint').textContent;

  // rows
  const n = state.cart.length;
  const store = currentStore();
  $('r-cart').textContent = n
    ? `${plural(n, 'prodotto', 'prodotti')} · ${euro(total)}${state.split ? ' · 2 scontrini' : ''}`
    : 'Vuoto: scansiona o scrivi un prezzo';
  const todo = state.list.filter((l) => !l.done).length;
  const done = state.list.length - todo;
  $('r-list').textContent = state.list.length === 0 ? 'Scrivi cosa ti serve'
    : todo === 0 ? 'Hai preso tutto ✓'
    : `${todo} da prendere${done ? ` · ${done} presi` : ''}`;
  const nc = state.cards.length;
  $('r-cards').textContent = nc ? `${plural(nc, 'carta', 'carte')} · tocca per il codice` : 'Aggiungi le tessere dei negozi';
  $('r-stack').innerHTML = state.cards.slice(0, 3).map((c) => {
    const t = tileHtml(c);
    return `<span class="ctile mini${t.light ? ' light' : ''}" style="${t.style}">${t.inner}</span>`;
  }).join('');
  const np = Object.keys(state.catalog).length;
  $('r-prod').textContent = np ? `${plural(np, 'prodotto salvato', 'prodotti salvati')}${store ? ` · prezzi di ${store}` : ''}` : 'Scansiona per salvare nome e prezzo';
  const now = new Date();
  const month = state.history.filter((h) => { const d = new Date(h.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  $('r-hist').textContent = month.length
    ? `Questo mese ${euro(month.reduce((a, h) => a + h.total, 0))} · ${month.reduce((a, h) => a + h.vouchers, 0)} buoni`
    : 'Nessuna spesa questo mese';
  $('r-opts').textContent = `Buoni da ${euro(s.value)} · massimo ${s.maxPerTrip} · ne hai ${s.wallet}`;

  // horizontal row of loyalty cards: one tap shows the barcode
  $('h-cards').innerHTML = state.cards.map((c) => {
    const t = tileHtml(c);
    return `<button type="button" class="hcard" data-card="${escapeHtml(c.id)}" aria-label="Mostra la carta ${escapeHtml(c.name)}">
      <span class="ctile${t.light ? ' light' : ''}" style="${t.style}">${t.inner}</span>
      <span class="hcard-name">${escapeHtml(c.name)}</span></button>`;
  }).join('') + `<button type="button" class="hcard add" data-card-new aria-label="Aggiungi carta">
      <span class="ctile"><span class="cplus">+</span></span><span class="hcard-name">Aggiungi</span></button>`;

  paintPeek();
}

function paintPeek() {
  const total = cartTotal();
  const n = state.cart.length;
  if (sheetOpen) {
    $('bs-title').textContent = VIEW_TITLES[currentView] || '';
    let sub = '';
    if (currentView === 'spesa') sub = [currentStore(), n ? plural(n, 'prodotto', 'prodotti') : ''].filter(Boolean).join(' · ');
    if (currentView === 'lista') { const t = state.list.filter((l) => !l.done).length; sub = t ? `${t} da prendere` : ''; }
    $('bs-sub').textContent = sub;
    $('bs-peek-total').textContent = '';
  } else {
    $('bs-title').textContent = 'Scontrino virtuale';
    $('bs-sub').textContent = n ? `${plural(n, 'prodotto', 'prodotti')} · trascina su per aprire` : 'Trascina su per aggiungere prodotti';
    $('bs-peek-total').textContent = euro(total);
  }
}

// ---------- sheet position ----------
function measureSheet() {
  const probe = $('safe-probe');
  const safeBottom = probe ? probe.offsetHeight : 0;
  closedY = Math.max(0, sheet.offsetHeight - sheetHead.offsetHeight - safeBottom);
  if (!sheet.classList.contains('dragging')) placeSheet(sheetOpen ? 0 : closedY, false);
}

function placeSheet(y, animate) {
  sheetY = y;
  sheet.classList.toggle('animate', !!animate);
  sheet.style.transform = `translate3d(0, ${y}px, 0)`;
  const p = closedY ? Math.min(1, Math.max(0, 1 - y / closedY)) : (sheetOpen ? 1 : 0);
  root.style.setProperty('--sp', p.toFixed(3));
  root.classList.toggle('sheet-animate', !!animate);
}

function setSheet(open) {
  const was = sheetOpen;
  sheetOpen = open;
  root.classList.toggle('sheet-open', open);
  sheet.setAttribute('aria-modal', open ? 'true' : 'false');
  $('home').inert = open;
  sheetBody.inert = !open;
  placeSheet(open ? 0 : closedY, true);
  paintPeek();
  if (!open && was) {
    const a = document.activeElement;
    if (a && sheet.contains(a)) a.blur();
    // next time the peek opens the receipt
    setTimeout(() => { if (!sheetOpen && currentView !== 'spesa') showView('spesa', true); }, 400);
  }
  if (open !== was) haptic(1);
}

// called by showView() in app.js
function sheetShows(view, keepClosed) {
  if (!keepClosed && !sheetOpen) setSheet(true);
  else paintPeek();
}

function openSheet(view) { showView(view); }
function closeSheet() { setSheet(false); }

// ---------- drag gesture ----------
// The handle area always drags. Inside the content, pulling down when it is already
// scrolled to the top drags the sheet too, like the iPhone's own sheets.
let drag = null;

function dragBegin(y, fromBody) {
  drag = { y0: y, start: sheetY, last: y, t: performance.now(), v: 0, fromBody, active: !fromBody, moved: false };
}
function dragMove(y, e) {
  if (!drag) return;
  const dy = y - drag.y0;
  if (!drag.active) {
    // content: only a downward pull at the top becomes a sheet drag
    if (Math.abs(dy) < 6) return;
    if (dy < 0 || sheetBody.scrollTop > 0) { drag = null; return; }
    drag.active = true;
    drag.y0 = y;
  }
  if (e && e.cancelable) e.preventDefault();
  if (Math.abs(y - drag.y0) > 4) drag.moved = true;
  sheet.classList.add('dragging');
  const now = performance.now();
  const dt = Math.max(1, now - drag.t);
  drag.v = 0.8 * ((y - drag.last) / dt) + 0.2 * drag.v;
  drag.last = y;
  drag.t = now;
  let ny = drag.start + (y - drag.y0);
  if (ny < 0) ny = ny / 4;                       // rubber band above the top
  if (ny > closedY) ny = closedY + (ny - closedY) / 4;
  placeSheet(ny, false);
}
function dragEnd() {
  if (!drag) return false;
  const d = drag;
  drag = null;
  sheet.classList.remove('dragging');
  if (!d.active || !d.moved) { if (d.active) placeSheet(sheetOpen ? 0 : closedY, true); return false; }
  const fast = Math.abs(d.v) > 0.45;
  let open;
  if (fast) open = d.v < 0;
  else open = sheetY < closedY * (sheetOpen ? 0.3 : 0.75);
  if (open && !sheetOpen) showView('spesa');
  else setSheet(open);
  return true;
}

// touch (iPhone)
sheetHead.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || e.target.closest('#bs-close')) return;
  dragBegin(e.touches[0].clientY, false);
}, { passive: true });
sheetBody.addEventListener('touchstart', (e) => {
  if (!sheetOpen || e.touches.length !== 1) return;
  // horizontal scrollers and inputs keep their own gestures
  if (e.target.closest('.chips, select, input, textarea')) return;
  if (sheetBody.scrollTop > 0) return;
  dragBegin(e.touches[0].clientY, true);
}, { passive: true });
sheet.addEventListener('touchmove', (e) => { if (drag) dragMove(e.touches[0].clientY, e); }, { passive: false });
sheet.addEventListener('touchend', (e) => { if (dragEnd() && e.cancelable) e.preventDefault(); });
sheet.addEventListener('touchcancel', () => { if (drag) { drag.moved = false; dragEnd(); } });

// mouse (desktop): handle only
sheetHead.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('#bs-close')) return;
  dragBegin(e.clientY, false);
  const mv = (ev) => dragMove(ev.clientY, ev);
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); if (dragEnd()) sheetHead.dataset.dragged = '1'; };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', up);
});

// tap on the peek opens the receipt
sheetHead.addEventListener('click', (e) => {
  if (sheetHead.dataset.dragged) { delete sheetHead.dataset.dragged; return; }
  if (e.target.closest('#bs-close')) return;
  if (!sheetOpen) showView('spesa');
});
$('bs-close').addEventListener('click', closeSheet);
$('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetOpen && $('card-view').hidden && $('card-edit').hidden && $('scanner').hidden && !document.querySelector('dialog[open]')) closeSheet();
});

// ---------- home actions ----------
$('home').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openSheet(open.dataset.open);
  const card = e.target.closest('[data-card]');
  if (card) return openCard(card.dataset.card);
  if (e.target.closest('[data-card-new]')) return openCardEditor(null);
});
$('home-opts').addEventListener('click', () => openSheet('impostazioni'));
$('qa-scan').addEventListener('click', () => {
  // the receipt opens underneath, so after the scan the product is right there
  showView('spesa');
  openScanner('cart');
});
$('qa-more').addEventListener('click', () => {
  const d = $('more-dialog');
  d.returnValue = '';
  d.showModal();
});
$('more-dialog').addEventListener('close', () => {
  const v = $('more-dialog').returnValue;
  if (v === 'prodotti' || v === 'storico' || v === 'impostazioni') openSheet(v);
  else if (v === 'nuovo') { openSheet('prodotti'); openEditor(null, ''); }
  else if (v === 'carta') openCardEditor(null);
  else if (v === 'negozi') { openSheet('impostazioni'); setTimeout(() => { $('store-list').scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 350); }
});
$('more-dialog').addEventListener('click', (e) => { if (e.target === $('more-dialog')) $('more-dialog').close('cancel'); });

// ---------- start ----------
(() => {
  const probe = document.createElement('div');
  probe.id = 'safe-probe';
  probe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(probe);
})();
sheetBody.inert = true;
renderHome();
measureSheet();
window.addEventListener('resize', measureSheet);
window.addEventListener('orientationchange', () => setTimeout(measureSheet, 300));
requestAnimationFrame(() => { measureSheet(); sheet.classList.add('ready'); });
