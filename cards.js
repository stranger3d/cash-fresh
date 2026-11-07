'use strict';
// Loyalty cards ("Carte fedeltà"): a grid of coloured tiles, one per card. Tapping a tile
// shows the card's barcode large on white, ready for the checkout scanner.
//
// No official logos are bundled (they are trademarks): every chain is drawn as its name
// in a typeface and colours close to its brand. The user can upload a logo photo for any card.

// f: wordmark style. b = heavy sans, r = rounded, s = serif italic, c = condensed caps
const CHAINS = [
  { id: 'conad', name: 'Conad', word: 'Conad', bg: '#e30613', fg: '#ffd500', f: 'r' },
  { id: 'coop', name: 'Coop', word: 'coop', bg: '#e2001a', fg: '#ffffff', f: 'r' },
  { id: 'esselunga', name: 'Esselunga', word: 'esselunga', bg: '#0b4ea2', fg: '#ffffff', f: 'b', alias: ['fidaty'] },
  { id: 'lidl', name: 'Lidl', word: 'LIDL', bg: '#0050aa', fg: '#fff000', f: 'b', ring: '#e60a14' },
  { id: 'carrefour', name: 'Carrefour', word: 'Carrefour', bg: '#ffffff', fg: '#1e5bc6', f: 'b', dot: '#e3001b' },
  { id: 'eurospin', name: 'Eurospin', word: 'EUROSPIN', bg: '#003d8f', fg: '#ffd400', f: 'c' },
  { id: 'penny', name: 'Penny', word: 'PENNY', bg: '#cd1719', fg: '#ffffff', f: 'c' },
  { id: 'md', name: 'MD', word: 'MD', bg: '#ffe500', fg: '#e2001a', f: 'b' },
  { id: 'despar', name: 'Despar', word: 'DESPAR', bg: '#ffffff', fg: '#d7141a', f: 'b', dot: '#00813e', alias: ['eurospar', 'interspar', 'spar'] },
  { id: 'pam', name: 'Pam', word: 'pam', bg: '#e3000b', fg: '#ffffff', f: 'r', alias: ['pam panorama', 'panorama'] },
  { id: 'iper', name: 'Iper', word: 'iper', bg: '#1d3e8a', fg: '#ffffff', f: 'r', dot: '#e30613', alias: ['iper la grande i'] },
  { id: 'tigros', name: 'Tigros', word: 'Tigros', bg: '#f39200', fg: '#ffffff', f: 'b' },
  { id: 'aldi', name: 'Aldi', word: 'ALDI', bg: '#00205b', fg: '#ffffff', f: 'b', ring: '#ff7800' },
  { id: 'famila', name: 'Famila', word: 'famila', bg: '#e30613', fg: '#ffffff', f: 's' },
  { id: 'crai', name: 'Crai', word: 'CRAI', bg: '#ffffff', fg: '#e30613', f: 'b', dot: '#009639' },
  { id: 'sigma', name: 'Sigma', word: 'Sigma', bg: '#e31e24', fg: '#ffffff', f: 's' },
  { id: 'bennet', name: 'Bennet', word: 'Bennet', bg: '#004b93', fg: '#ffffff', f: 'b', dot: '#e30613' },
  { id: 'iperal', name: 'Iperal', word: 'IPERAL', bg: '#e30613', fg: '#ffffff', f: 'c' },
  { id: 'unes', name: 'Unes', word: 'unes', bg: '#e2001a', fg: '#ffffff', f: 'r', alias: ['u2'] },
  { id: 'gigante', name: 'il Gigante', word: 'il Gigante', bg: '#e2001a', fg: '#ffe600', f: 's', alias: ['gigante'] },
  { id: 'todis', name: 'Todis', word: 'TODIS', bg: '#00963f', fg: '#ffffff', f: 'c' },
  { id: 'deco', name: 'Decò', word: 'Decò', bg: '#e30613', fg: '#ffffff', f: 's', alias: ['deco'] },
  { id: 'basko', name: 'Basko', word: 'BASKO', bg: '#00843d', fg: '#ffffff', f: 'c' },
  { id: 'naturasi', name: 'NaturaSì', word: 'NaturaSì', bg: '#7ab929', fg: '#ffffff', f: 's', alias: ['naturasi'] },
  { id: 'tigota', name: 'Tigotà', word: 'Tigotà', bg: '#e6007e', fg: '#ffffff', f: 'r', alias: ['tigota'] },
  { id: 'acquaesapone', name: 'Acqua & Sapone', word: 'Acqua & Sapone', bg: '#0067b1', fg: '#ffffff', f: 's', alias: ['acqua e sapone'] }
];
const chainById = (id) => CHAINS.find((c) => c.id === id) || null;
const CARD_SWATCHES = ['#e30613', '#f39200', '#ffd500', '#7ab929', '#00843d', '#0b4ea2', '#00205b', '#6a4c9c', '#e6007e', '#4a3f3a', '#e8e4dc', '#ffffff'];
const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const safeColor = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : d);
const safeLogo = (u) => (typeof u === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(u) ? u : '');

// black or white text, whichever reads better on the colour
function inkFor(bg) {
  const n = parseInt(bg.slice(1), 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#1b1b1b' : '#ffffff';
}

function chainFor(name) {
  const n = normName(name);
  if (!n) return null;
  return CHAINS.find((c) => normName(c.name) === n || (c.alias || []).some((a) => normName(a) === n)) || null;
}

// the card that belongs to a store chosen in the Spesa tab
function cardForStore(store) {
  const n = normName(store);
  if (!n) return null;
  const ch = chainFor(store);
  return state.cards.find((c) => normName(c.name) === n || (ch && c.chain === ch.id)) || null;
}

// ---------- tiles ----------
function tileHtml(card) {
  const ch = chainById(card.chain);
  const bg = safeColor(card.bg, ch ? ch.bg : '#6a4c9c');
  const fg = safeColor(card.fg, ch ? ch.fg : inkFor(bg));
  const logo = safeLogo(card.logo);
  const light = inkFor(bg) !== '#ffffff';
  const style = `background:${bg};color:${fg}`;
  if (logo) return { style, light, inner: `<img src="${logo}" alt="">` };
  const word = (ch && card.name === ch.name ? ch.word : card.name) || 'Carta';
  const len = word.length;
  const size = len <= 3 ? 'xl' : len <= 5 ? 'l' : len <= 8 ? 'm' : len <= 12 ? 's' : 'xs';
  const deco = ch && ch.ring ? `<i class="cring" style="border-color:${ch.ring}"></i>` : '';
  const dot = ch && ch.dot ? `<i class="cdot" style="background:${ch.dot}"></i>` : '';
  return { style, light, inner: `${deco}<span class="cword f-${ch ? ch.f : 'b'} ${size}">${escapeHtml(word)}${dot}</span>` };
}
function paintTile(el, card) {
  const t = tileHtml(card);
  el.setAttribute('style', t.style);
  el.classList.toggle('light', t.light);
  el.innerHTML = t.inner;
}

// ---------- wallet grid ----------
function renderCards() {
  const grid = $('wallet');
  grid.innerHTML = state.cards.map((c) => {
    const t = tileHtml(c);
    return `<button type="button" class="ctile${t.light ? ' light' : ''}" style="${t.style}" data-card="${escapeHtml(c.id)}" aria-label="Carta ${escapeHtml(c.name)}">${t.inner}</button>`;
  }).join('');
  $('wallet-empty').hidden = state.cards.length > 0;
  paintStoreCard();
  if (typeof renderHome === 'function') renderHome();
}

function paintStoreCard() {
  const btn = $('store-card');
  if (!btn) return;
  const store = currentStore();
  const card = store ? cardForStore(store) : null;
  btn.hidden = !card;
  if (!card) return;
  btn.dataset.card = card.id;
  paintTile($('store-card-tile'), card);
  $('store-card-text').textContent = `Mostra la carta ${card.name}`;
}

$('wallet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-card]');
  if (b) openCard(b.dataset.card);
});
$('store-card').addEventListener('click', (e) => openCard(e.currentTarget.dataset.card));
$('card-add').addEventListener('click', () => openCardEditor(null));
$('card-add-top').addEventListener('click', () => openCardEditor(null));

// ---------- pages ----------
function showPage(id, on) {
  const el = $(id);
  el.hidden = !on;
  if (on) { el.scrollTop = 0; el.classList.remove('in'); void el.offsetWidth; el.classList.add('in'); }
  document.documentElement.classList.toggle('page-open', !$('card-view').hidden || !$('card-edit').hidden);
}

// ---------- card detail ----------
let viewId = null;
let wakeLock = null;

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
    return true;
  } catch (e) { return false; }
}
function letSleep() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  // iOS drops the lock when the app goes to the background: take it again on return
  if (document.visibilityState === 'visible' && viewId && !$('card-view').hidden) keepAwake();
});

function loadScript(src, global) {
  if (window[global]) return Promise.resolve(window[global]);
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = () => resolve(window[global]);
    sc.onerror = reject;
    document.head.appendChild(sc);
  });
}

const groupNumber = (n) => /^\d{9,}$/.test(n) ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : n;

async function drawCode(box, number, format) {
  box.innerHTML = '';
  box.classList.toggle('qr', format === 'QR');
  try {
    if (format === 'QR') {
      const qr = (await loadScript('vendor/qrcode.js', 'qrcode'))(0, 'M');
      qr.addData(number);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
      return true;
    }
    const JsBarcode = await loadScript('vendor/jsbarcode.min.js', 'JsBarcode');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    box.appendChild(svg);
    let ok = true;
    const opts = { format: format || 'CODE128', displayValue: false, margin: 0, height: 110, width: 3, background: '#ffffff', lineColor: '#000000', valid: (v) => { ok = v; } };
    try { JsBarcode(svg, number, opts); } catch (e) { ok = false; }
    if (!ok) { JsBarcode(svg, number, { ...opts, format: 'CODE128', valid: undefined }); return false; }
    return true;
  } catch (e) {
    box.innerHTML = '<p class="code-err">Non riesco a disegnare il codice: mostra il numero alla cassa.</p>';
    return false;
  }
}

async function openCard(id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return;
  viewId = id;
  card.used = Date.now();
  save();
  $('cv-title').textContent = card.name;
  $('cv-menu').hidden = true;
  paintTile($('cv-tile'), card);
  $('cv-num').textContent = groupNumber(card.number);
  $('cv-hint').textContent = '';
  showPage('card-view', true);
  const exact = await drawCode($('cv-code'), card.number, card.format);
  const awake = await keepAwake();
  $('cv-hint').innerHTML = (exact ? '' : '<strong>Il numero non è valido per il tipo di codice scelto: mostro un Code 128. Controlla in Modifica carta.</strong><br>') +
    '☀︎ Se la cassa non legge il codice, alza la luminosità dal Centro di Controllo.' + (awake ? ' Lo schermo resta acceso finché la carta è aperta.' : '');
}
function closeCard() {
  viewId = null;
  letSleep();
  showPage('card-view', false);
}
$('cv-back').addEventListener('click', closeCard);
$('cv-more').addEventListener('click', (e) => { e.stopPropagation(); $('cv-menu').hidden = !$('cv-menu').hidden; });
$('card-view').addEventListener('click', (e) => { if (!e.target.closest('#cv-menu')) $('cv-menu').hidden = true; });
$('cv-edit').addEventListener('click', () => { $('cv-menu').hidden = true; openCardEditor(viewId); });
$('cv-delete').addEventListener('click', () => { $('cv-menu').hidden = true; deleteCard(viewId); });

function deleteCard(id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card || !confirm(`Eliminare la carta ${card.name}?`)) return;
  state.cards = state.cards.filter((c) => c.id !== id);
  save();
  renderCards();
  showPage('card-edit', false);
  closeCard();
  toast(`Carta ${card.name} eliminata`);
}

// ---------- add / edit ----------
let draft = null;      // card being edited
let editId = null;
let formatTouched = false;

function eanOk(d) {
  if (!/^\d+$/.test(d)) return false;
  const digits = d.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((s, v, i) => s + v * (i % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}
function guessFormat(n) {
  if (/^\d{13}$/.test(n) && eanOk(n)) return 'EAN13';
  if (/^\d{8}$/.test(n) && eanOk(n)) return 'EAN8';
  if (/^\d{12}$/.test(n) && eanOk(n)) return 'UPC';
  return 'CODE128';
}

// most likely chain for a new card: the store chosen in Spesa that has no card yet
function suggestedChain() {
  const st = currentStore();
  const ch = st ? chainFor(st) : null;
  if (ch && !state.cards.some((c) => c.chain === ch.id)) return ch;
  return null;
}

function renderChainGrid() {
  const own = (state.settings.stores || []).map((s) => chainFor(s)).filter(Boolean);
  const order = [...new Set([...own, ...CHAINS])];
  const sug = suggestedChain();
  if (sug) order.splice(order.indexOf(sug), 1), order.unshift(sug);
  const cell = (inner, attrs, label, on) =>
    `<button type="button" class="chain${on ? ' on' : ''}" ${attrs} aria-pressed="${on}"><span class="ctile mini${inner.light ? ' light' : ''}" style="${inner.style}">${inner.inner}</span><span class="chain-name">${label}</span></button>`;
  $('ce-chains').innerHTML = order.map((ch) => {
    const t = tileHtml({ chain: ch.id, name: ch.name });
    const on = draft.chain === ch.id;
    return cell(t, `data-chain="${ch.id}"`, escapeHtml(ch.name) + (ch === sug && !editId ? ' <em>qui ora</em>' : ''), on);
  }).join('') + cell({ style: '', inner: '<span class="cplus">+</span>', light: true }, 'data-chain=""', 'Altra carta', draft.chain === '' && draft.other);
}

function paintDraft() {
  paintTile($('ce-tile'), draft);
  $('ce-swatches').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.color === draft.bg));
  const pick = $('ce-color');
  if (pick) pick.value = draft.bg;
  $('ce-logo-del').hidden = !draft.logo;
  $('ce-logo').textContent = draft.logo ? 'Cambia logo' : 'Carica il logo da una foto';
}

function openCardEditor(id, prefill) {
  const card = id ? state.cards.find((c) => c.id === id) : null;
  editId = card ? card.id : null;
  draft = card ? { ...card, other: !card.chain }
    : { chain: '', name: '', number: '', format: 'EAN13', bg: '#6a4c9c', fg: '#ffffff', logo: '', other: false };
  if (!card) {
    const sug = suggestedChain();
    if (sug) Object.assign(draft, { chain: sug.id, name: sug.name, bg: sug.bg, fg: sug.fg });
  }
  if (prefill) Object.assign(draft, prefill);
  formatTouched = !!card;
  $('ce-title').textContent = card ? 'Modifica carta' : 'Nuova carta';
  $('ce-number').value = draft.number || '';
  $('ce-number').classList.remove('invalid');
  $('ce-name').value = draft.name || '';
  $('ce-format').value = draft.format || 'CODE128';
  $('ce-scanned').hidden = true;
  $('ce-err').hidden = true;
  $('ce-delete').hidden = !card;
  $('ce-scan').hidden = !!card;
  renderChainGrid();
  paintDraft();
  showPage('card-edit', true);
}

function closeEditor() {
  showPage('card-edit', false);
  draft = null;
}

$('ce-back').addEventListener('click', closeEditor);
$('ce-delete').addEventListener('click', () => deleteCard(editId));

$('ce-swatches').innerHTML = CARD_SWATCHES.map((c) =>
  `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="Colore ${c}"></button>`).join('') +
  '<label class="swatch any" aria-label="Altro colore"><input type="color" id="ce-color" value="#6a4c9c"></label>';
function setColor(c) {
  draft.bg = c;
  draft.fg = inkFor(c);
  paintDraft();
}
$('ce-swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-color]');
  if (b) setColor(b.dataset.color);
});
$('ce-color').addEventListener('input', (e) => setColor(e.target.value.toLowerCase()));

$('ce-chains').addEventListener('click', (e) => {
  const b = e.target.closest('button.chain');
  if (!b) return;
  const ch = chainById(b.dataset.chain);
  if (ch) {
    Object.assign(draft, { chain: ch.id, name: ch.name, bg: ch.bg, fg: ch.fg, logo: '', other: false });
    $('ce-name').value = ch.name;
  } else {
    const wasChain = !!draft.chain;
    Object.assign(draft, { chain: '', other: true });
    if (wasChain) { draft.name = ''; draft.logo = ''; $('ce-name').value = ''; setColor('#6a4c9c'); }
    setTimeout(() => $('ce-name').focus(), 50);
  }
  renderChainGrid();
  paintDraft();
});

$('ce-name').addEventListener('input', (e) => {
  draft.name = e.target.value.trim();
  paintDraft();
});

$('ce-number').addEventListener('input', (e) => {
  draft.number = e.target.value.trim();
  e.target.classList.remove('invalid');
  if (!formatTouched) $('ce-format').value = draft.format = guessFormat(draft.number.replace(/\s/g, ''));
});
$('ce-format').addEventListener('change', (e) => { formatTouched = true; draft.format = e.target.value; });

$('ce-scan').addEventListener('click', () => {
  openScanner('card', (code, format) => {
    if (!draft) return;
    const known = state.cards.find((c) => c.number === code);
    if (known && !editId) {
      closeEditor();
      toast(`Hai già questa carta: ${known.name}`);
      openCard(known.id);
      return;
    }
    draft.number = code;
    draft.format = format || guessFormat(code);
    formatTouched = !!format;
    $('ce-number').value = code;
    $('ce-format').value = draft.format;
    const note = $('ce-scanned');
    note.hidden = false;
    note.textContent = draft.chain
      ? `Codice letto ✓ Controlla il negozio qui sotto e salva.`
      : `Codice letto ✓ Ora scegli il negozio qui sotto.`;
    $('ce-chains').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
});

// logo: resized on the phone so it stays small in storage and in the backup
$('ce-logo').addEventListener('click', () => $('ce-logo-file').click());
$('ce-logo-del').addEventListener('click', () => { draft.logo = ''; paintDraft(); });
$('ce-logo-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    const max = 480;
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * k);
    cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    draft.logo = f.type === 'image/png' ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
    URL.revokeObjectURL(url);
    paintDraft();
  };
  img.onerror = () => { URL.revokeObjectURL(url); alert('Non riesco ad aprire questa immagine.'); };
  img.src = url;
});

$('ce-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('ce-err');
  const fmt = $('ce-format').value;
  let number = $('ce-number').value.trim();
  if (fmt !== 'QR' && fmt !== 'CODE128' && fmt !== 'CODE39') number = number.replace(/\s/g, '');
  const name = $('ce-name').value.trim();
  const fail = (msg, el) => { err.textContent = msg; err.hidden = false; if (el) { el.classList.add('invalid'); el.focus(); } };
  if (!number) return fail('Scansiona la carta o scrivi il numero.', $('ce-number'));
  if (!name) return fail(draft.chain || draft.other ? 'Scrivi il nome sulla carta.' : 'Scegli il negozio qui sopra, oppure "Altra carta".', draft.chain || draft.other ? $('ce-name') : null);
  if ((fmt === 'EAN13' || fmt === 'EAN8' || fmt === 'UPC') && !(/^\d+$/.test(number) && number.length === { EAN13: 13, EAN8: 8, UPC: 12 }[fmt])) {
    return fail('Questo numero non è un ' + $('ce-format').selectedOptions[0].textContent + '. Scegli "Code 128" come tipo di codice.', $('ce-format'));
  }
  const now = Date.now();
  const card = {
    id: editId || uid(),
    chain: draft.chain || '',
    name: name.slice(0, 40),
    number: number.slice(0, 200),
    format: fmt,
    bg: safeColor(draft.bg, '#6a4c9c'),
    fg: safeColor(draft.fg, '#ffffff'),
    logo: safeLogo(draft.logo),
    added: draft.added || now,
    used: now
  };
  if (editId) state.cards = state.cards.map((c) => (c.id === editId ? card : c));
  else state.cards.push(card);
  save();
  renderCards();
  closeEditor();
  openCard(card.id);
  if (!editId) toast(`Carta ${card.name} salvata ✓`);
});

// backup import: same number + name = same card
function importCards(list) {
  let n = 0;
  list.forEach((x) => {
    if (!x || typeof x !== 'object') return;
    const number = typeof x.number === 'string' ? x.number.slice(0, 200) : '';
    const name = typeof x.name === 'string' ? x.name.slice(0, 40) : '';
    if (!number || !name) return;
    if (state.cards.some((c) => c.number === number && normName(c.name) === normName(name))) return;
    const chain = typeof x.chain === 'string' && chainById(x.chain) ? x.chain : '';
    const bg = safeColor(x.bg, chain ? chainById(chain).bg : '#6a4c9c');
    state.cards.push({
      id: uid(), chain, name, number,
      format: normFormat(x.format) || (x.format === 'QR' ? 'QR' : 'CODE128'),
      bg, fg: safeColor(x.fg, inkFor(bg)), logo: safeLogo(x.logo),
      added: Number.isFinite(x.added) ? x.added : Date.now(),
      used: Number.isFinite(x.used) ? x.used : Date.now()
    });
    n++;
  });
  return n;
}

renderCards();
