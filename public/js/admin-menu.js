// Dashboard: menu editor (items with photos, both languages, nutrition, options), branding,
// promotional banners, menu display mode, and the live orders tab with order-station devices.
import { mountBoard } from './orders-board.js';

const TAG_LABEL = { vegetarian: 'Vegetarian', vegan: 'Vegan', spicy: 'Spicy', new: 'New', popular: 'Popular', gluten_free: 'Gluten free', chef: "Chef's pick", healthy: 'Healthy' };
const ALLERGEN_LABEL = { gluten: 'Gluten', dairy: 'Dairy', egg: 'Eggs', nuts: 'Tree nuts', peanuts: 'Peanuts', sesame: 'Sesame', soy: 'Soy', fish: 'Fish', shellfish: 'Shellfish', mustard: 'Mustard', celery: 'Celery' };
const ERR = {
  CALORIES_REQUIRED: 'Calories are required for restaurants in Saudi Arabia (SFDA menu labelling).',
  UNSUPPORTED_FILE: 'Use a real JPG, PNG or WEBP picture.', FILE_TOO_LARGE: 'The picture is too large (max 10 MB).',
  VALIDATION_FAILED: 'Please check the highlighted values.', TOO_MANY_BANNERS: 'Up to 12 banners.', MENU_TOO_LARGE: 'The menu is limited to 1000 items.',
  LINK_NOT_FOUND: 'The linked item or category no longer exists.',
};
const err = (e, fallback = 'Something went wrong') => ERR[e?.code] ?? e?.code ?? fallback;

export async function uploadImage(kind, file) {
  const res = await fetch(`/api/admin/media/${kind}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error });
  return data;
}

export function createMenuAdmin(env) {
  const { h, api, fm, cur, msg, render, parseMajor, decimalsOf } = env;
  const toMajor = (m) => { const d = decimalsOf(cur()); return (Number(m) / 10 ** d).toFixed(d); };
  const both = (o, f = 'name') => [o[`${f}_en`], o[`${f}_ar`]].filter(Boolean).join(' · ');
  const modal = (...kids) => {
    const dlg = h('div', { class: 'scrim', onclick: (e) => { if (e.target === dlg) dlg.remove(); } }, h('div', { class: 'card modal form' }, ...kids));
    document.body.append(dlg);
    return dlg;
  };
  const autoBadge = (item, field) => (item?.auto_translated ?? []).includes(field) ? h('span', { class: 'chip warn', title: 'Filled by machine translation — please review' }, 'auto-translated') : null;

  // --------------------------------------------------------------- image picker
  function imagePicker(kind, { current, label, onChange, wide }) {
    const preview = h('div', { class: `img-pick${wide ? ' wide' : ''}` });
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
    const out = h('p', { class: 'note' });
    let id = current ?? null;
    function paint() {
      preview.replaceChildren(id ? h('img', { src: `/media/${id}`, alt: '' }) : h('span', { class: 'muted' }, 'No picture'));
    }
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      msg(out, 'Uploading…', true);
      try { const r = await uploadImage(kind, f); id = r.id; paint(); msg(out, ''); onChange?.(id); } catch (e) { msg(out, err(e)); }
      input.value = '';
    });
    paint();
    return {
      el: h('div', { class: 'img-field' }, h('span', { class: 'lbl' }, label), preview,
        h('div', { class: 'row gap' }, h('button', { class: 'btn soft sm', type: 'button', onclick: () => input.click() }, id ? 'Change' : 'Upload'),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { id = null; paint(); onChange?.(null); } }, 'Remove')), input, out),
      get value() { return id; },
    };
  }

  // --------------------------------------------------------------- item editor
  function editItem(item, cat, data) {
    const isNew = !item.id;
    const s = data.settings;
    const pic = imagePicker('item', { current: item.image_id, label: 'Photo (square works best)' });
    const f = {
      cat: h('select', null, data.categories.map((k) => h('option', { value: k.id, selected: k.id === (item.category_id ?? cat.id) }, both(k)))),
      en: h('input', { value: item.name_en ?? '', maxlength: '120', placeholder: 'e.g. Chicken shawarma' }),
      ar: h('input', { value: item.name_ar ?? '', maxlength: '120', dir: 'rtl', placeholder: 'مثال: شاورما دجاج' }),
      de: h('textarea', { rows: '3', maxlength: '300', placeholder: 'Ingredients, how it is served…' }),
      da: h('textarea', { rows: '3', maxlength: '300', dir: 'rtl', placeholder: 'المكونات وطريقة التقديم…' }),
      price: h('input', { value: item.price_minor != null ? toMajor(item.price_minor) : '', inputmode: 'decimal', placeholder: '0.00' }),
      kcal: h('input', { value: item.calories ?? '', inputmode: 'numeric', placeholder: s.country === 'SA' ? 'required' : 'optional' }),
      caf: h('input', { value: item.caffeine_mg ?? '', inputmode: 'numeric', placeholder: 'drinks only' }),
      salt: h('input', { type: 'checkbox', checked: Boolean(item.high_salt) }),
      avail: h('input', { type: 'checkbox', checked: item.available !== false }),
    };
    f.de.value = item.description_en ?? '';
    f.da.value = item.description_ar ?? '';
    const tagBoxes = data.tags.map((t) => h('input', { type: 'checkbox', value: t, checked: (item.tags ?? []).includes(t) }));
    const alBoxes = data.allergens.map((a) => h('input', { type: 'checkbox', value: a, checked: (item.allergens ?? []).includes(a) }));

    // options builder: a working copy, painted into `optBox`
    const groups = structuredClone(item.options ?? []);
    const optBox = h('div', { class: 'opt-groups' });
    function paintOptions() {
      optBox.replaceChildren(...groups.map((g, gi) => h('div', { class: 'opt-group' },
        h('div', { class: 'grid2' },
          h('input', { value: g.name_en ?? '', placeholder: 'Group (EN) e.g. Size', oninput: (e) => { g.name_en = e.target.value; } }),
          h('input', { value: g.name_ar ?? '', dir: 'rtl', placeholder: 'المجموعة مثال: الحجم', oninput: (e) => { g.name_ar = e.target.value; } })),
        h('div', { class: 'row gap' },
          h('label', { class: 'inline' }, 'Min', h('input', { inputmode: 'numeric', value: g.min ?? 0, oninput: (e) => { g.min = Number(e.target.value) || 0; } })),
          h('label', { class: 'inline' }, 'Max', h('input', { inputmode: 'numeric', value: g.max ?? 1, oninput: (e) => { g.max = Number(e.target.value) || 1; } })),
          h('small', { class: 'muted' }, 'Min 1 = required. Max 1 = pick one.'),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { groups.splice(gi, 1); paintOptions(); } }, 'Remove group')),
        ...g.choices.map((c, ci) => h('div', { class: 'opt-choice' },
          h('input', { value: c.name_en ?? '', placeholder: 'Choice (EN)', oninput: (e) => { c.name_en = e.target.value; } }),
          h('input', { value: c.name_ar ?? '', dir: 'rtl', placeholder: 'الخيار', oninput: (e) => { c.name_ar = e.target.value; } }),
          h('input', { value: c.price_minor ? toMajor(c.price_minor) : '', inputmode: 'decimal', placeholder: `+ ${cur()}`, oninput: (e) => { c._price = e.target.value; } }),
          h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'remove', onclick: () => { g.choices.splice(ci, 1); paintOptions(); } }, '✕'))),
        h('button', { class: 'btn soft sm', type: 'button', onclick: () => { g.choices.push({ name_en: '', name_ar: '', price_minor: 0 }); paintOptions(); } }, '+ Choice'))));
    }
    paintOptions();

    const out = h('p', { class: 'note' });
    const save = h('button', { class: 'btn primary', type: 'button' }, isNew ? 'Add item' : 'Save');
    const num = (el) => (el.value.trim() === '' ? null : Number(el.value));
    save.addEventListener('click', async () => {
      let body;
      try {
        body = {
          category_id: f.cat.value, name_en: f.en.value.trim() || null, name_ar: f.ar.value.trim() || null,
          description_en: f.de.value.trim() || null, description_ar: f.da.value.trim() || null,
          price_minor: parseMajor(f.price.value, cur()), available: f.avail.checked, image_id: pic.value,
          calories: num(f.kcal), caffeine_mg: num(f.caf), high_salt: f.salt.checked,
          tags: tagBoxes.filter((b) => b.checked).map((b) => b.value), allergens: alBoxes.filter((b) => b.checked).map((b) => b.value),
          options: groups.map((g) => ({
            ...(g.id ? { id: g.id } : {}), name_en: g.name_en?.trim() || null, name_ar: g.name_ar?.trim() || null, min: g.min ?? 0, max: g.max ?? 1,
            choices: g.choices.filter((c) => c.name_en?.trim() || c.name_ar?.trim()).map((c) => ({
              ...(c.id ? { id: c.id } : {}), name_en: c.name_en?.trim() || null, name_ar: c.name_ar?.trim() || null,
              price_minor: c._price !== undefined ? (c._price.trim() ? parseMajor(c._price, cur()) : 0) : Number(c.price_minor ?? 0),
            })),
          })),
        };
      } catch { return msg(out, `Check the prices (e.g. 12.50 ${cur()}).`); }
      if (!body.name_en && !body.name_ar) return msg(out, 'Enter the name in at least one language.');
      if (s.country === 'SA' && body.calories == null) return msg(out, ERR.CALORIES_REQUIRED);
      save.disabled = true;
      try {
        await api(isNew ? 'POST' : 'PUT', isNew ? '/api/admin/menu/items' : `/api/admin/menu/items/${item.id}`, body);
        dlg.remove();
        render();
      } catch (e) { save.disabled = false; msg(out, err(e, 'Check the values')); }
    });

    const dlg = modal(
      h('h2', null, isNew ? 'New item' : 'Edit item'),
      h('div', { class: 'editor' },
        h('div', { class: 'editor-side' }, pic.el,
          h('label', null, 'Category', f.cat),
          h('label', null, `Price (${cur()}, VAT included)`, f.price),
          h('label', { class: 'check' }, f.avail, 'Available (untick when sold out)')),
        h('div', { class: 'editor-main' },
          s.translation
            ? h('p', { class: 'hint' }, '✨ Fill one language and leave the other empty — it is translated automatically when you save. You can edit the translation afterwards.')
            : h('p', { class: 'hint warn' }, 'Automatic translation is not configured, so please enter both languages.'),
          h('div', { class: 'grid2' },
            h('label', null, h('span', null, 'Name (English) ', autoBadge(item, 'name_en')), f.en),
            h('label', null, h('span', null, 'الاسم (عربي) ', autoBadge(item, 'name_ar')), f.ar),
            h('label', null, h('span', null, 'Description (English) ', autoBadge(item, 'description_en')), f.de),
            h('label', null, h('span', null, 'الوصف (عربي) ', autoBadge(item, 'description_ar')), f.da)),
          h('h3', null, 'Nutrition & labels'),
          h('div', { class: 'grid3' },
            h('label', null, `Calories (kcal)${s.country === 'SA' ? ' *' : ''}`, f.kcal),
            h('label', null, 'Caffeine (mg)', f.caf),
            h('label', { class: 'check' }, f.salt, 'High in salt')),
          h('div', null, h('span', { class: 'lbl' }, 'Tags'), h('div', { class: 'checks' }, tagBoxes.map((b) => h('label', { class: 'check pill' }, b, TAG_LABEL[b.value] ?? b.value)))),
          h('div', null, h('span', { class: 'lbl' }, 'Allergens'), h('div', { class: 'checks' }, alBoxes.map((b) => h('label', { class: 'check pill' }, b, ALLERGEN_LABEL[b.value] ?? b.value)))),
          h('h3', null, 'Options & add-ons'),
          h('p', { class: 'muted small' }, 'Sizes, milk type, extras… Diners pick them when ordering; prices are added automatically.'),
          optBox,
          h('button', { class: 'btn soft sm', type: 'button', onclick: () => { groups.push({ name_en: '', name_ar: '', min: 0, max: 1, choices: [{ name_en: '', name_ar: '', price_minor: 0 }] }); paintOptions(); } }, '+ Option group'))),
      h('div', { class: 'row gap sticky-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.remove() }, 'Cancel'), save, out));
    dlg.querySelector('.modal').classList.add('xl');
  }

  // --------------------------------------------------------------- banners
  function editBanner(b, data) {
    const isNew = !b.id;
    const pic = imagePicker('banner', { current: b.image_id, label: 'Banner picture (2:1, e.g. 1200×600)', wide: true });
    const items = data.categories.flatMap((c) => c.items.map((i) => ({ ...i, cat: c })));
    const linkType = h('select', null, [['none', 'Not clickable (view only)'], ['item', 'Opens an item'], ['category', 'Opens a category']]
      .map(([v, l]) => h('option', { value: v, selected: (b.link_type ?? 'none') === v }, l)));
    const linkItem = h('select', null, items.map((i) => h('option', { value: i.id, selected: b.link_id === i.id }, `${both(i)} — ${both(i.cat)}`)));
    const linkCat = h('select', null, data.categories.map((c) => h('option', { value: c.id, selected: b.link_id === c.id }, both(c))));
    const local = (iso) => (iso ? new Date(new Date(iso) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    const f = {
      en: h('input', { value: b.title_en ?? '', maxlength: '80', placeholder: 'e.g. 20% off breakfast until 11am' }),
      ar: h('input', { value: b.title_ar ?? '', maxlength: '80', dir: 'rtl', placeholder: 'مثال: خصم ٢٠٪ على الفطور' }),
      start: h('input', { type: 'datetime-local', value: local(b.starts_at) }),
      end: h('input', { type: 'datetime-local', value: local(b.ends_at) }),
      active: h('input', { type: 'checkbox', checked: b.active !== false }),
    };
    const linkWrap = h('div');
    const paintLink = () => linkWrap.replaceChildren(linkType.value === 'item' ? h('label', null, 'Item', linkItem) : linkType.value === 'category' ? h('label', null, 'Category', linkCat) : '');
    linkType.addEventListener('change', paintLink);
    paintLink();
    const out = h('p', { class: 'note' });
    const dlg = modal(h('h2', null, isNew ? 'New banner' : 'Edit banner'), pic.el,
      h('p', { class: 'muted small' }, 'The title is shown on the picture (optional). Leave one language empty to translate it automatically.'),
      h('div', { class: 'grid2' }, h('label', null, 'Title (English)', f.en), h('label', null, 'العنوان (عربي)', f.ar)),
      h('label', null, 'When tapped', linkType), linkWrap,
      h('div', { class: 'grid2' }, h('label', null, 'Show from (optional)', f.start), h('label', null, 'Until (optional)', f.end)),
      h('label', { class: 'check' }, f.active, 'Visible to diners'),
      h('div', { class: 'row gap' }, h('button', { class: 'btn ghost', onclick: () => dlg.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          if (!pic.value) return msg(out, 'Upload the banner picture first.');
          const lt = linkType.value;
          try {
            await api(isNew ? 'POST' : 'PUT', isNew ? '/api/admin/menu/banners' : `/api/admin/menu/banners/${b.id}`, {
              image_id: pic.value, title_en: f.en.value.trim() || null, title_ar: f.ar.value.trim() || null,
              link_type: lt, link_id: lt === 'item' ? linkItem.value : lt === 'category' ? linkCat.value : null,
              starts_at: f.start.value ? new Date(f.start.value).toISOString() : null,
              ends_at: f.end.value ? new Date(f.end.value).toISOString() : null, active: f.active.checked,
            });
            dlg.remove(); render();
          } catch (e) { msg(out, err(e, 'Check the values')); }
        } }, isNew ? 'Add banner' : 'Save')), out);
  }

  function bannersCard(data, canEdit) {
    const now = Date.now();
    const state = (b) => (!b.active ? ['Hidden', 'bad'] : b.ends_at && new Date(b.ends_at) < now ? ['Ended', 'bad']
      : b.starts_at && new Date(b.starts_at) > now ? ['Scheduled', 'warn'] : ['Live', 'captured']);
    const linkLabel = (b) => {
      if (b.link_type === 'item') { const i = data.categories.flatMap((c) => c.items).find((x) => x.id === b.link_id); return i ? `→ ${both(i)}` : '→ item'; }
      if (b.link_type === 'category') { const c = data.categories.find((x) => x.id === b.link_id); return c ? `→ ${both(c)}` : '→ category'; }
      return 'View only';
    };
    return h('div', { class: 'card wide' },
      h('div', { class: 'row' }, h('h3', null, 'Promotional banners'),
        canEdit ? h('button', { class: 'btn primary sm', onclick: () => editBanner({}, data) }, '+ Add banner') : null),
      h('p', { class: 'muted small' }, 'Shown at the top of the menu. Several banners slide automatically; diners can also swipe them.'),
      data.banners.length ? h('div', { class: 'banner-list' }, data.banners.map((b) => {
        const [st, cls] = state(b);
        return h('div', { class: 'banner-row' },
          h('img', { src: `/media/${b.image_id}`, alt: '' }),
          h('div', null, h('strong', null, both(b, 'title') || '(no title)'), h('small', { class: 'muted block' }, linkLabel(b)),
            h('small', { class: 'muted block' }, `${b.views} views · ${b.clicks} taps${b.ends_at ? ` · until ${new Date(b.ends_at).toLocaleString()}` : ''}`)),
          h('span', { class: `chip ${cls}` }, st),
          canEdit ? h('div', { class: 'row gap' },
            h('button', { class: 'btn ghost sm', onclick: () => editBanner(b, data) }, 'Edit'),
            h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', `/api/admin/menu/banners/${b.id}`); render(); } }, 'Delete')) : null);
      })) : h('p', { class: 'muted' }, 'No banners yet.'));
  }

  // --------------------------------------------------------------- display & branding
  function displayCard(data, canEdit) {
    const s = data.settings;
    const out = h('p', { class: 'note' });
    const modes = [
      ['file', 'Uploaded menu (PDF / photos)', 'Diners see only your own menu file. Items below are used by staff to build bills.'],
      ['browse', 'Interactive menu — view only', 'Photos, descriptions, prices, calories and banners. No ordering.'],
      ['order', 'Interactive menu + ordering', 'Diners send orders from the table; you accept them under Orders and they are added to the bill.'],
    ];
    const radios = modes.map(([v]) => h('input', { type: 'radio', name: 'menu_mode', value: v, checked: s.menu_mode === v, disabled: !canEdit }));
    const login = h('input', { type: 'checkbox', checked: s.order_requires_login, disabled: !canEdit });
    const waiter = h('input', { type: 'checkbox', checked: s.waiter_call_enabled, disabled: !canEdit });
    const saveS = async () => {
      try {
        await api('PUT', '/api/admin/menu/settings', { menu_mode: radios.find((r) => r.checked).value, order_requires_login: login.checked, waiter_call_enabled: waiter.checked });
        msg(out, 'Saved', true);
        setTimeout(render, 500);
      } catch (e) { msg(out, err(e)); }
    };
    return h('div', { class: 'card wide' }, h('h3', null, 'What diners see'),
      h('div', { class: 'modes' }, modes.map(([v, l, d], i) => h('label', { class: `mode${s.menu_mode === v ? ' on' : ''}` }, radios[i], h('strong', null, l), h('small', { class: 'muted' }, d)))),
      h('label', { class: 'check' }, login, 'Diners must sign in with WhatsApp before ordering'),
      h('label', { class: 'check' }, waiter, 'Show “Call a waiter / Ask for the bill” button'),
      h('p', { class: 'muted small' }, s.translation ? 'Automatic Arabic ⇄ English translation: on.' : 'Automatic translation: off (the platform needs a DEEPL_API_KEY or GOOGLE_TRANSLATE_API_KEY).'),
      canEdit ? h('button', { class: 'btn primary sm', onclick: saveS }, 'Save') : null, out);
  }

  function brandingCard(data, canEdit) {
    const s = data.settings;
    const del = (kind) => async () => { await api('DELETE', `/api/admin/media/branding/${kind}`); render(); };
    const pickLogo = imagePicker('logo', { current: s.logo_media, label: 'Logo (square)', onChange: (id) => { if (!id) del('logo')(); } });
    const pickCover = imagePicker('cover', { current: s.cover_media, label: 'Header picture (wide)', wide: true, onChange: (id) => { if (!id) del('cover')(); } });
    return h('div', { class: 'card wide' }, h('h3', null, 'Logo & header'),
      h('p', { class: 'muted small' }, 'Without a header picture the menu uses a clean white header with your logo.'),
      canEdit ? h('div', { class: 'brand-pickers' }, pickLogo.el, pickCover.el) : h('p', { class: 'muted' }, 'Managers can change these.'));
  }

  // --------------------------------------------------------------- items list
  function categoryCard(c, data, canEdit) {
    const editCat = () => {
      const en = h('input', { value: c.name_en }), ar = h('input', { value: c.name_ar, dir: 'rtl' });
      const out = h('p', { class: 'note' });
      const dlg = modal(h('h2', null, 'Rename category'), h('label', null, 'English', en), h('label', null, 'عربي', ar),
        h('div', { class: 'row gap' }, h('button', { class: 'btn ghost', onclick: () => dlg.remove() }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: async () => {
            try { await api('PUT', `/api/admin/menu/categories/${c.id}`, { name_en: en.value.trim() || null, name_ar: ar.value.trim() || null }); dlg.remove(); render(); } catch (e) { msg(out, err(e)); }
          } }, 'Save')), out);
    };
    return h('div', { class: 'card wide' },
      h('div', { class: 'row' }, h('h3', null, both(c)),
        canEdit ? h('div', { class: 'row gap' },
          h('button', { class: 'btn primary sm', onclick: () => editItem({}, c, data) }, '+ Add item'),
          h('button', { class: 'btn ghost sm', onclick: editCat }, 'Rename'),
          h('button', { class: 'btn ghost sm', onclick: () => {
            const dlg = modal(h('h2', null, `Delete “${both(c)}”?`), h('p', null, `This also deletes its ${c.items.length} items.`),
              h('div', { class: 'row gap' }, h('button', { class: 'btn ghost', onclick: () => dlg.remove() }, 'Cancel'),
                h('button', { class: 'btn primary', onclick: async () => { await api('DELETE', `/api/admin/menu/categories/${c.id}`); dlg.remove(); render(); } }, 'Delete')));
          } }, 'Delete')) : null),
      c.items.length ? h('div', { class: 'item-list' }, c.items.map((i) => h('div', { class: `item-row${i.available ? '' : ' off'}` },
        i.image_id ? h('img', { src: `/media/${i.image_id}`, alt: '', loading: 'lazy' }) : h('div', { class: 'noimg' }, '🍽'),
        h('div', { class: 'item-info' },
          h('div', { class: 'names' }, h('strong', null, i.name_en || '—'), i.name_ar ? h('span', { class: 'muted', dir: 'rtl' }, i.name_ar) : null),
          i.description_en || i.description_ar ? h('small', { class: 'muted block clamp' }, i.description_en || i.description_ar) : null,
          h('div', { class: 'row gap tiny' },
            i.calories != null ? h('span', { class: 'chip' }, `${i.calories} kcal`) : (data.settings.country === 'SA' ? h('span', { class: 'chip bad' }, 'calories missing') : null),
            i.options.length ? h('span', { class: 'chip' }, `${i.options.length} option group${i.options.length > 1 ? 's' : ''}`) : null,
            i.tags.map((t) => h('span', { class: 'chip' }, TAG_LABEL[t] ?? t)),
            i.auto_translated.length ? h('span', { class: 'chip warn' }, 'auto-translated') : null)),
        h('strong', { class: 'num' }, fm(i.price_minor)),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: i.available, onchange: async (e) => { await api('POST', `/api/admin/menu/items/${i.id}/availability`, { available: e.target.checked }); } }), 'Available'),
        canEdit ? h('div', { class: 'row gap' },
          h('button', { class: 'btn ghost sm', onclick: () => editItem(i, c, data) }, 'Edit'),
          h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', `/api/admin/menu/items/${i.id}`); render(); } }, 'Delete')) : null)))
        : h('p', { class: 'muted' }, 'No items yet.'));
  }

  function addCategoryCard() {
    const en = h('input', { placeholder: 'Category (English)' }), ar = h('input', { placeholder: 'القسم (عربي)', dir: 'rtl' });
    const out = h('p', { class: 'note' });
    return h('div', { class: 'card form' }, h('h3', null, 'Add category'), en, ar,
      h('small', { class: 'muted' }, 'One language is enough — the other is translated automatically.'),
      h('button', { class: 'btn primary sm', onclick: async () => {
        try { await api('POST', '/api/admin/menu/categories', { name_en: en.value.trim() || null, name_ar: ar.value.trim() || null }); render(); } catch (e) { msg(out, err(e, 'Enter a name')); }
      } }, 'Add'), out);
  }

  return { editItem, bannersCard, displayCard, brandingCard, categoryCard, addCategoryCard };
}

// ----------------------------------------------------------------- Orders tab
export function createOrdersAdmin(env) {
  const { h, api, msg, render, me, summary } = env;
  let stop = null;

  async function devicesCard() {
    if (me().role === 'staff') return null;
    const { devices } = await api('GET', '/api/admin/devices');
    const name = h('input', { placeholder: 'e.g. Kitchen printer, Bar tablet', maxlength: '60' });
    const out = h('p', { class: 'note' });
    const showQr = (d, r) => {
      const dlg = h('div', { class: 'scrim' }, h('div', { class: 'card modal form' },
        h('h2', null, `Pair “${d.name}”`),
        h('ol', null, h('li', null, 'On the device (phone, tablet or Sunmi POS with printer), open the camera.'),
          h('li', null, 'Scan this code. The device opens the orders screen and stays signed in.'),
          h('li', null, `The code works once and expires in ${r.expires_in_minutes} minutes.`)),
        h('div', { class: 'qr big' }, h('img', { alt: 'pairing QR', src: `data:image/svg+xml;base64,${btoa(r.qr_svg)}` })),
        h('p', { class: 'muted small' }, 'For printing: on Sunmi/Android POS devices choose the built-in printer once in the print dialog and enable “Auto-print on accept”.'),
        h('button', { class: 'btn primary', onclick: () => { dlg.remove(); render(); } }, 'Done')));
      document.body.append(dlg);
    };
    return h('div', { class: 'card wide' }, h('h3', null, 'Order stations (devices)'),
      h('p', { class: 'muted small' }, 'A device paired here can only see and update orders and waiter calls — no payments, reports or settings.'),
      devices.length ? h('table', null, h('tbody', null, devices.map((d) => h('tr', null,
        h('td', null, h('strong', null, d.name)),
        h('td', null, d.paired_at ? h('span', { class: 'chip captured' }, 'Paired') : h('span', { class: 'chip warn' }, d.pairing ? 'Waiting for scan' : 'Not paired')),
        h('td', { class: 'muted' }, d.last_seen_at ? `Last seen ${new Date(d.last_seen_at).toLocaleString()}` : '—'),
        h('td', null, h('button', { class: 'btn ghost sm', onclick: async () => showQr(d, await api('POST', `/api/admin/devices/${d.id}/pair-code`, {})) }, 'New pairing code'), ' ',
          h('button', { class: 'btn ghost sm', onclick: async () => { await api('DELETE', `/api/admin/devices/${d.id}`); render(); } }, 'Remove')))))) : h('p', { class: 'muted' }, 'No devices yet.'),
      h('div', { class: 'row gap' }, name, h('button', { class: 'btn primary sm', onclick: async () => {
        try { const r = await api('POST', '/api/admin/devices', { name: name.value.trim() }); showQr(r, r); } catch (e) { msg(out, e.code === 'VALIDATION_FAILED' ? 'Enter a device name' : e.code); }
      } }, '+ Add device')), out,
      h('p', { class: 'muted small' }, 'Tip: you can also open ', h('a', { href: '/station', target: '_blank', rel: 'noopener' }, '/station'), ' on any computer where you are signed in to this dashboard.'));
  }

  return {
    stop() { stop?.(); stop = null; },
    async view() {
      const boardEl = h('div', { class: 'card wide' });
      stop?.();
      stop = mountBoard(boardEl, { restaurant: summary().restaurant, onAuthLost: () => location.reload() });
      return h('div', { class: 'grid' }, boardEl, await devicesCard());
    },
  };
}
