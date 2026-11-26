// Interactive menu for diners: cover + logo, promotional banners, sticky categories with
// scroll-spy, search, item details (nutrition, allergens, options) and table ordering.
// Plain DOM only (no innerHTML). The menu node is built once and kept, so the banner
// carousel and the scroll position survive cart updates.

const MEDIA = /^\/media\/[0-9a-f-]{36}$/i;
const STATUS_STEPS = ['new', 'preparing', 'ready', 'served'];

export function createMenu(env) {
  const { S, h, t, money, icon, I, api, toast, render, go, errText } = env;
  const fmt = (k, vars) => t(k).replace(/\{(\w+)\}/g, (_, v) => vars[v]);
  const name = (o) => (S.lang === 'ar' ? o.name_ar || o.name_en : o.name_en || o.name_ar) ?? '';
  const desc = (o) => (S.lang === 'ar' ? o.description_ar || o.description_en : o.description_en || o.description_ar) ?? '';
  const title = (o) => (S.lang === 'ar' ? o.title_ar || o.title_en : o.title_en || o.title_ar) ?? '';
  const src = (u) => (typeof u === 'string' && (MEDIA.test(u) || /^https:\/\//.test(u)) ? u : null);
  const menu = () => S.data.restaurant.menu;
  const canOrder = () => Boolean(menu().ordering);
  const rtl = () => S.lang === 'ar';
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  const randKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));

  let cache = null;      // { el, menuRef, lang, dock, ordersBtn, timer }
  let sheetDraw = null;  // redraw function of the open menu sheet
  let pollT = null;

  // ------------------------------------------------------------------ cart
  const cartKey = () => `orderize_cart_${S.token}`;
  function loadCart() {
    try { S.cart = JSON.parse(sessionStorage.getItem(cartKey())) ?? null; } catch { S.cart = null; }
    if (!S.cart || !Array.isArray(S.cart.lines)) S.cart = { lines: [], note: '', key: null };
  }
  function saveCart() { try { sessionStorage.setItem(cartKey(), JSON.stringify(S.cart)); } catch { /* private mode */ } }
  function itemsIndex() {
    const map = new Map();
    for (const c of menu().categories ?? []) for (const it of c.items ?? []) if (it.id) map.set(it.id, it);
    return map;
  }
  function unitPrice(it, optionIds) {
    const picked = new Set(optionIds);
    let p = Number(it.price_minor);
    for (const g of it.options ?? []) for (const c of g.choices) if (picked.has(c.id)) p += Number(c.price_minor ?? 0);
    return p;
  }
  function optionLabels(it, optionIds) {
    const picked = new Set(optionIds);
    return (it.options ?? []).flatMap((g) => g.choices.filter((c) => picked.has(c.id)).map(name));
  }
  function cartLines() {
    const idx = itemsIndex();
    S.cart.lines = S.cart.lines.filter((l) => idx.get(l.item_id)?.available !== false && idx.has(l.item_id));
    return S.cart.lines.map((l) => ({ ...l, item: idx.get(l.item_id), unit: unitPrice(idx.get(l.item_id), l.options) }));
  }
  function addLine(it, options, qty, note) {
    const same = S.cart.lines.find((l) => l.item_id === it.id && !l.note && !note && l.options.join() === [...options].sort().join());
    if (same) same.qty = Math.min(20, same.qty + qty);
    else S.cart.lines.push({ uid: randKey(), item_id: it.id, options: [...options].sort(), qty, note: note || '' });
    S.cart.key = null; // contents changed: a new order key
    saveCart();
    refreshDynamic();
  }

  // ------------------------------------------------------------------ orders
  async function refreshOrders() {
    clearTimeout(pollT);
    if (!S.token || !canOrder()) { S.orders = []; return; }
    try { S.orders = (await api.orders(S.token)).orders; } catch { /* keep previous */ }
    refreshDynamic();
    sheetDraw?.('orders');
    if (S.orders.some((o) => ['new', 'preparing', 'ready'].includes(o.status))) {
      pollT = setTimeout(() => { if (document.visibilityState === 'visible') refreshOrders(); else pollT = setTimeout(refreshOrders, 6000); }, 6000);
    }
  }

  function openSheet(kind, extra = {}) {
    S.sheet = kind;
    S.sheetV = (S.sheetV ?? 0) + 1;
    Object.assign(S, extra);
    render();
  }

  // ------------------------------------------------------------------ building blocks
  function langBtn() {
    return h('button', { class: 'mx-round', 'aria-label': 'language', onclick: () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; env.saveLang(S.lang); render(); } },
      h('span', { class: 'mx-lang' }, S.lang === 'ar' ? 'EN' : 'ع'));
  }

  function carousel(banners) {
    const slides = banners.map((b) => {
      const clickable = b.link_type && b.link_type !== 'none';
      const cap = title(b);
      return h(clickable ? 'button' : 'div', {
        class: `mx-slide${clickable ? ' is-link' : ''}`,
        onclick: clickable ? () => {
          api.bannerClick(S.token, b.id).catch(() => {});
          if (b.link_type === 'item') openItem(b.link_id);
          else scrollToSection(b.link_id);
        } : null,
      },
      h('img', { src: src(b.image), alt: cap, draggable: 'false' }),
      cap ? h('div', { class: 'mx-slide-cap' }, h('strong', null, cap), clickable ? icon(I.chev, 18) : null) : null);
    });
    const track = h('div', { class: 'mx-track', role: 'region', 'aria-roledescription': 'carousel', 'aria-label': 'offers' }, slides);
    const dots = slides.length > 1 ? h('div', { class: 'mx-dots' }, slides.map((_, i) => h('button', { 'aria-label': `${i + 1}`, onclick: () => { pause(); goTo(i); } }))) : null;
    let idx = 0, paused = false, resumeT = null, visible = true;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function delta(el) {
      const tr = track.getBoundingClientRect(), sr = el.getBoundingClientRect();
      const pad = 16;
      return rtl() ? sr.right - (tr.right - pad) : sr.left - (tr.left + pad);
    }
    function goTo(i) { track.scrollBy({ left: delta(slides[i]), behavior: reduce ? 'auto' : 'smooth' }); }
    function current() {
      let best = 0, bd = Infinity;
      slides.forEach((s, i) => { const d = Math.abs(delta(s)); if (d < bd) { bd = d; best = i; } });
      return best;
    }
    function paint() { if (dots) [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx)); }
    function pause() { paused = true; clearTimeout(resumeT); resumeT = setTimeout(() => { paused = false; }, 6000); }
    track.addEventListener('scroll', () => { idx = current(); paint(); }, { passive: true });
    for (const ev of ['pointerdown', 'touchstart', 'wheel']) track.addEventListener(ev, pause, { passive: true });
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(track);
    paint();
    const timer = slides.length > 1 && !reduce ? setInterval(() => {
      if (paused || !visible || !track.isConnected || document.visibilityState !== 'visible' || S.sheet) return;
      idx = (idx + 1) % slides.length;
      goTo(idx);
    }, 4500) : null;
    return { el: h('section', { class: 'mx-banners' }, track, dots), timer };
  }

  function addButton(it) {
    return h('button', {
      class: 'mx-add', 'aria-label': t('addToOrder'),
      onclick: (e) => {
        e.stopPropagation();
        if ((it.options ?? []).length) return openItem(it.id);
        addLine(it, [], 1, '');
        toast(t('added'));
      },
    }, icon(I.plus, 18));
  }

  function itemCard(it) {
    const sold = it.available === false;
    const pic = src(it.image);
    const tags = (it.tags ?? []).slice(0, 3);
    const card = h('article', {
      class: `mx-item${sold ? ' sold' : ''}`, tabindex: '0', role: 'button',
      onclick: () => openItem(it.id), onkeydown: (e) => { if (e.key === 'Enter') openItem(it.id); },
    },
    h('div', { class: 'mx-item-text' },
      h('h3', null, name(it)),
      desc(it) ? h('p', { class: 'mx-desc' }, desc(it)) : null,
      tags.length ? h('div', { class: 'mx-tags' }, tags.map((tg) => h('span', { class: `mx-tag t-${tg}` }, t(`tag_${tg}`)))) : null,
      h('div', { class: 'mx-meta' },
        h('strong', { class: 'mx-price' }, money(it.price_minor)),
        it.calories != null ? h('span', { class: 'mx-kcal' }, `${it.calories} ${t('kcal')}`) : null,
        sold ? h('span', { class: 'mx-sold' }, t('soldOut')) : null)),
    pic || (canOrder() && !sold)
      ? h('div', { class: `mx-thumb${pic ? '' : ' empty'}` },
        pic ? h('img', { src: pic, alt: '', loading: 'lazy', decoding: 'async' }) : null,
        canOrder() && !sold && it.id ? addButton(it) : null)
      : null);
    card.dataset.q = norm(`${it.name_en} ${it.name_ar} ${it.description_en ?? ''} ${it.description_ar ?? ''}`);
    return card;
  }

  function scrollToSection(id) {
    const sec = cache?.el.querySelector(`[data-cat="${CSS.escape(id ?? '')}"]`);
    if (!sec) return;
    const offset = (cache.sticky?.offsetHeight ?? 0) + 8;
    cache.lock = Date.now();
    window.scrollTo({ top: sec.getBoundingClientRect().top + scrollY - offset, behavior: 'smooth' });
    setActive(id);
  }
  function setActive(id) {
    if (!cache?.tabs) return;
    for (const b of cache.tabs.children) {
      const on = b.dataset.cat === id;
      b.classList.toggle('on', on);
      if (on) {
        const tr = cache.tabs.getBoundingClientRect(), br = b.getBoundingClientRect();
        cache.tabs.scrollBy({ left: (br.left + br.width / 2) - (tr.left + tr.width / 2), behavior: 'smooth' });
      }
    }
  }

  // ------------------------------------------------------------------ the page
  function build() {
    if (cache?.timer) clearInterval(cache.timer);
    const r = S.data.restaurant;
    const m = menu();
    const cover = src(m.cover) ?? src(r.cover_url);
    const logo = src(m.logo) ?? src(r.logo_url);
    const initials = (r.name_en.match(/\b\w/g) || []).slice(0, 2).join('');
    const cats = (m.categories ?? []).filter((c) => (c.items ?? []).length);
    const c = { menuRef: m, lang: S.lang };

    const backBtn = h('button', { class: 'mx-round', 'aria-label': t('back'), onclick: () => go(S.data.require_phone && !S.data.me ? 'login' : 'home') }, icon(I.back));
    const bell = m.waiter_call ? h('button', { class: 'mx-round', 'aria-label': t('callWaiter'), onclick: () => openSheet('help') }, icon(I.bell)) : null;
    c.ordersBtn = h('button', { class: 'mx-orders', hidden: true, onclick: () => openSheet('orders') });

    const hero = h('header', { class: `mx-hero${cover ? ' has-cover' : ''}` },
      cover ? h('img', { class: 'mx-cover', src: cover, alt: '' }) : null,
      h('div', { class: 'mx-actions' }, backBtn, h('div', { class: 'mx-actions-end' }, bell, langBtn())));
    const ident = h('div', { class: 'mx-ident' },
      h('div', { class: 'mx-logo' }, logo ? h('img', { src: logo, alt: '' }) : h('span', { class: 'mx-initials' }, initials)),
      h('h1', null, name(r)),
      h('p', { class: 'mx-sub' }, fmt('tableN', { n: S.data.table.label })),
      c.ordersBtn);

    let banners = null;
    if ((m.banners ?? []).length) {
      const car = carousel(m.banners);
      banners = car.el;
      c.timer = car.timer;
      const seenKey = `orderize_seen_${S.token}`;
      try {
        if (!sessionStorage.getItem(seenKey)) { sessionStorage.setItem(seenKey, '1'); api.bannersSeen(S.token, m.banners.map((b) => b.id)).catch(() => {}); }
      } catch { /* ignore */ }
    }

    const search = h('input', { type: 'search', class: 'mx-search', placeholder: t('menuSearch'), 'aria-label': t('menuSearch'), enterkeyhint: 'search' });
    c.tabs = h('div', { class: 'mx-tabs', role: 'tablist' },
      cats.map((cat, i) => {
        const b = h('button', { class: i === 0 ? 'on' : '', role: 'tab', onclick: () => scrollToSection(cat.id ?? `c${i}`) }, name(cat));
        b.dataset.cat = cat.id ?? `c${i}`;
        return b;
      }));
    c.sticky = h('div', { class: 'mx-sticky' }, h('div', { class: 'mx-search-wrap' }, icon(I.search, 18), search), cats.length > 1 ? c.tabs : null);

    const sections = cats.map((cat, i) => {
      const sec = h('section', { class: 'mx-sec' }, h('h2', null, name(cat)), cat.items.map(itemCard));
      sec.dataset.cat = cat.id ?? `c${i}`;
      return sec;
    });
    const empty = h('p', { class: 'mx-empty', hidden: true }, t('noResults'));
    search.addEventListener('input', () => {
      const q = norm(search.value.trim());
      let any = false;
      for (const sec of sections) {
        let n = 0;
        for (const card of sec.querySelectorAll('.mx-item')) { const hit = !q || card.dataset.q.includes(q); card.hidden = !hit; if (hit) n++; }
        sec.hidden = n === 0;
        any ||= n > 0;
      }
      empty.hidden = any;
      if (banners) banners.hidden = Boolean(q);
    });

    c.dock = h('div', { class: 'dock', hidden: true });
    c.el = h('div', { class: 'mx' }, hero, ident, banners, c.sticky, h('div', { class: 'mx-list' }, sections, empty),
      h('p', { class: 'powered' }, 'Orderize'), c.dock);

    // scroll-spy
    const spy = new IntersectionObserver((es) => {
      if (Date.now() - (cache?.lock ?? 0) < 900) return;
      const top = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.dataset.cat);
    }, { rootMargin: '-120px 0px -65% 0px' });
    sections.forEach((s) => spy.observe(s));
    return c;
  }

  function refreshDynamic() {
    if (!cache) return;
    const lines = canOrder() ? cartLines() : [];
    const count = lines.reduce((s, l) => s + l.qty, 0);
    const total = lines.reduce((s, l) => s + l.unit * l.qty, 0);
    const bill = S.data.bill;
    if (count) {
      cache.dock.replaceChildren(h('button', { class: 'btn primary big mx-cartbar', onclick: () => openSheet('cart') },
        h('span', { class: 'mx-count' }, String(count)), h('span', null, t('viewOrder')), h('span', { class: 'num' }, money(total))));
      cache.dock.hidden = false;
    } else if (bill?.remaining_minor > 0) {
      cache.dock.replaceChildren(h('button', { class: 'btn primary big', onclick: () => go('pay') }, `${t('payNow')} · ${money(bill.remaining_minor)}`));
      cache.dock.hidden = false;
    } else cache.dock.hidden = true;
    const active = (S.orders ?? []).filter((o) => o.status !== 'cancelled' && o.status !== 'served');
    cache.ordersBtn.hidden = !(S.orders ?? []).length;
    cache.ordersBtn.replaceChildren(icon(I.receipt, 16), `${t('yourOrders')}${active.length ? ` · ${t(`st_${active[0].status}`)}` : ''}`);
  }

  // ------------------------------------------------------------------ sheets
  function openItem(id) {
    const it = itemsIndex().get(id);
    if (!it) return;
    openSheet('item', { itemSheet: { id, picked: new Set((it.options ?? []).filter((g) => g.min === 1 && g.max === 1).map((g) => g.choices[0]?.id).filter(Boolean)), qty: 1, note: '' } });
  }

  function sheetItem() {
    const st = S.itemSheet;
    const it = itemsIndex().get(st.id);
    const box = h('div', { class: 'mx-sheet' });
    if (!it) return box;
    const sold = it.available === false;
    const allow = canOrder() && !sold;
    const pic = src(it.image);
    const addBtn = h('button', { class: 'btn primary big' });
    const groupsOk = () => (it.options ?? []).every((g) => {
      const n = g.choices.filter((c) => st.picked.has(c.id)).length;
      return n >= (g.min ?? 0) && n <= (g.max ?? 1);
    });
    const qtyEl = h('strong', { class: 'num' });
    function paint() {
      qtyEl.textContent = String(st.qty);
      addBtn.replaceChildren(`${t('addToOrder')} · ${money(unitPrice(it, [...st.picked]) * st.qty)}`);
      addBtn.disabled = !groupsOk();
      for (const row of box.querySelectorAll('.mx-choice')) row.classList.toggle('on', st.picked.has(row.dataset.id));
    }
    const nutrition = [
      it.calories != null ? h('span', { class: 'mx-chip' }, `${it.calories} ${t('kcal')}`) : null,
      it.caffeine_mg != null ? h('span', { class: 'mx-chip' }, `${t('caffeine')} ${it.caffeine_mg} ${t('mg')}`) : null,
      it.high_salt ? h('span', { class: 'mx-chip warn' }, t('highSalt')) : null,
      ...(it.tags ?? []).map((tg) => h('span', { class: `mx-chip mx-tag t-${tg}` }, t(`tag_${tg}`))),
    ].filter(Boolean);
    const groups = (it.options ?? []).map((g) => {
      const single = g.max === 1;
      const hint = g.min > 0
        ? `${t('required')} · ${g.min === g.max ? fmt('chooseN', { n: g.min }) : fmt('chooseRange', { a: g.min, b: g.max })}`
        : `${t('optional')} · ${fmt('upToN', { n: g.max })}`;
      return h('fieldset', { class: 'mx-group' },
        h('legend', null, h('strong', null, name(g)), h('small', null, hint)),
        g.choices.map((c) => {
          const row = h('button', {
            class: `mx-choice ${single ? 'radio' : 'check'}`, type: 'button', disabled: !allow,
            onclick: () => {
              if (single) { for (const x of g.choices) st.picked.delete(x.id); st.picked.add(c.id); }
              else if (st.picked.has(c.id)) st.picked.delete(c.id);
              else if (g.choices.filter((x) => st.picked.has(x.id)).length < g.max) st.picked.add(c.id);
              paint();
            },
          }, h('i'), h('span', null, name(c)), Number(c.price_minor) ? h('span', { class: 'num muted' }, `+${money(c.price_minor)}`) : null);
          row.dataset.id = c.id;
          return row;
        }));
    });
    addBtn.addEventListener('click', () => {
      if (!groupsOk()) return toast(errText('OPTIONS_INVALID'));
      addLine(it, [...st.picked], st.qty, st.note.trim());
      closeMenuSheet();
      toast(t('added'));
    });
    box.append(...[
      pic ? h('div', { class: 'mx-hero-pic' }, h('img', { src: pic, alt: '' })) : null,
      h('h2', null, name(it)),
      desc(it) ? h('p', { class: 'muted' }, desc(it)) : null,
      h('div', { class: 'mx-meta' }, h('strong', { class: 'mx-price lg' }, money(it.price_minor)), sold ? h('span', { class: 'mx-sold' }, t('soldOut')) : null),
      nutrition.length ? h('div', { class: 'mx-chips' }, nutrition) : null,
      (it.allergens ?? []).length ? h('p', { class: 'mx-allergens' }, h('strong', null, `${t('contains')}: `), it.allergens.map((a) => t(`al_${a}`)).join(S.lang === 'ar' ? '، ' : ', ')) : null,
      groups,
      allow ? [
        h('label', { class: 'field' }, t('specialReq'),
          h('input', { maxlength: '140', placeholder: t('notePh'), value: st.note, oninput: (e) => { st.note = e.target.value; } })),
        h('div', { class: 'mx-buy' },
          h('div', { class: 'stepper' },
            h('button', { 'aria-label': '-', onclick: () => { st.qty = Math.max(1, st.qty - 1); paint(); } }, icon(I.minus, 16)), qtyEl,
            h('button', { 'aria-label': '+', onclick: () => { st.qty = Math.min(20, st.qty + 1); paint(); } }, icon(I.plus, 16))),
          addBtn),
      ] : null].flat(Infinity).filter(Boolean));
    paint();
    return box;
  }

  function sheetCart() {
    const box = h('div', { class: 'mx-sheet' });
    let busy = false;
    function draw() {
      const lines = cartLines();
      if (!lines.length) { closeMenuSheet(); return; }
      const total = lines.reduce((s, l) => s + l.unit * l.qty, 0);
      const needLogin = menu().requires_login && !S.data.me;
      const note = h('textarea', { rows: '2', maxlength: '300', placeholder: t('orderNote'), oninput: (e) => { S.cart.note = e.target.value; saveCart(); } });
      note.value = S.cart.note ?? '';
      const bump = (l, d) => {
        const ref = S.cart.lines.find((x) => x.uid === l.uid);
        ref.qty += d;
        if (ref.qty <= 0) S.cart.lines = S.cart.lines.filter((x) => x.uid !== l.uid);
        if (ref.qty > 20) ref.qty = 20;
        S.cart.key = null;
        saveCart(); refreshDynamic(); draw();
      };
      box.replaceChildren(
        h('h2', null, t('yourOrder')),
        h('div', { class: 'mx-lines' }, lines.map((l) => h('div', { class: 'mx-line' },
          h('div', null, h('strong', null, name(l.item)),
            optionLabels(l.item, l.options).length ? h('small', { class: 'muted' }, optionLabels(l.item, l.options).join(' · ')) : null,
            l.note ? h('small', { class: 'muted' }, `“${l.note}”`) : null,
            h('span', { class: 'num' }, money(l.unit * l.qty))),
          h('div', { class: 'stepper sm' },
            h('button', { 'aria-label': '-', onclick: () => bump(l, -1) }, icon(l.qty === 1 ? I.x : I.minus, 14)),
            h('strong', { class: 'num' }, String(l.qty)),
            h('button', { 'aria-label': '+', onclick: () => bump(l, 1) }, icon(I.plus, 14)))))),
        note,
        h('div', { class: 'row between mx-total' }, h('strong', null, t('total')), h('strong', { class: 'num' }, money(total))),
        h('p', { class: 'muted small' }, t('addedToBill')),
        needLogin
          ? h('button', { class: 'btn primary big', onclick: () => { S.afterLogin = 'menu'; closeMenuSheet(); go('login'); } }, t('signInTitle'))
          : h('button', { class: 'btn primary big', disabled: busy, onclick: send }, `${t('sendOrder')} · ${money(total)}`));
    }
    async function send() {
      if (busy) return;
      busy = true; draw();
      S.cart.key ??= randKey();
      saveCart();
      try {
        await api.placeOrder(S.token, {
          client_key: S.cart.key,
          ...(S.cart.note?.trim() ? { note: S.cart.note.trim() } : {}),
          items: S.cart.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, options: l.options, ...(l.note ? { note: l.note } : {}) })),
        });
        S.cart = { lines: [], note: '', key: null };
        saveCart();
        await refreshOrders();
        openSheet('orders');
        toast(t('orderSent'));
      } catch (e) {
        busy = false;
        if (e.code === 'SIGN_IN_REQUIRED') { S.afterLogin = 'menu'; closeMenuSheet(); go('login'); return; }
        toast(errText(e.code));
        if (['ITEM_SOLD_OUT', 'ITEM_NOT_FOUND', 'OPTIONS_INVALID'].includes(e.code)) { await env.reload(); }
        draw();
      }
    }
    draw();
    sheetDraw = (k) => { if (k === 'cart') draw(); };
    return box;
  }

  function sheetOrders() {
    const box = h('div', { class: 'mx-sheet' });
    function draw() {
      box.replaceChildren(h('h2', null, t('yourOrders')),
        ...(S.orders ?? []).map((o) => {
          const step = STATUS_STEPS.indexOf(o.status);
          return h('div', { class: `mx-order s-${o.status}` },
            h('div', { class: 'row between' }, h('strong', null, `${t('orderNo')} #${o.number}`), h('span', { class: `chip st-${o.status}` }, t(`st_${o.status}`))),
            o.status !== 'cancelled' ? h('div', { class: 'mx-progress' }, STATUS_STEPS.map((_, i) => h('i', { class: i <= step ? 'on' : '' }))) : null,
            h('ul', null, o.items.map((l) => h('li', null, `${l.qty}× ${name(l)}${l.options?.length ? ` (${l.options.map(name).join(S.lang === 'ar' ? '، ' : ', ')})` : ''}`))),
            o.cancel_reason ? h('small', { class: 'muted' }, o.cancel_reason) : null,
            h('div', { class: 'row between' }, h('small', { class: 'muted' }, new Date(o.created_at).toLocaleTimeString(S.lang === 'ar' ? 'ar' : 'en', { hour: '2-digit', minute: '2-digit' })), h('span', { class: 'num' }, money(o.subtotal_minor))));
        }),
        h('p', { class: 'muted small' }, t('addedToBill')));
    }
    draw();
    sheetDraw = (k) => { if (k === 'orders') draw(); };
    return box;
  }

  function sheetHelp() {
    const call = (kind) => async () => {
      try { await api.callWaiter(S.token, kind); toast(t('waiterNotified')); closeMenuSheet(); } catch (e) { toast(errText(e.code)); }
    };
    return h('div', { class: 'mx-sheet' }, h('h2', null, t('needHelp')),
      h('button', { class: 'btn soft big', onclick: call('waiter') }, icon(I.bell), t('callWaiter')),
      h('button', { class: 'btn soft big', onclick: call('bill') }, icon(I.receipt), t('askBill')));
  }

  function closeMenuSheet() { S.sheet = null; sheetDraw = null; render(); }

  // ------------------------------------------------------------------ public
  return {
    sheets: { item: sheetItem, cart: sheetCart, orders: sheetOrders, help: sheetHelp },
    cachedSheets: new Set(['item', 'cart', 'orders', 'help']),
    view() {
      if (!S.cart) loadCart();
      if (!cache || cache.menuRef !== menu() || cache.lang !== S.lang) cache = build();
      refreshDynamic();
      return cache.el;
    },
    onLoad() {
      loadCart();
      if (canOrder()) refreshOrders();
    },
    openSheet,
    closeSheet: closeMenuSheet,
    hasOrders: () => (S.orders ?? []).length > 0,
  };
}
