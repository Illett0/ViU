// UI language support (issue #22): Japanese (the original) and English.
//
// Dynamic strings in JS use tr('日本語', 'English') — both languages sit
// side by side at the call site, so a string can't drift out of sync with a
// separate dictionary. Static text in index.html stays Japanese in the
// markup and carries its English in data-en (textContent), data-en-html
// (innerHTML, for text with links/markup), data-en-title, data-en-aria-label
// and data-en-placeholder; applyStaticTranslations() swaps them and keeps
// the Japanese original in data-ja-* so switching back works too.
//
// The language is owned by the main process (settings.json / OS locale, see
// main.js app:get-language) and fetched once here, before any other module
// renders. Leaf module: imports nothing from the app, and falls back to
// Japanese outside the app window so aggregate.mjs stays usable from plain
// Node scripts.

const bridge = typeof window !== 'undefined' ? window.pathBrowser : null;
let lang = bridge && (await bridge.getLanguage()) === 'en' ? 'en' : 'ja';

export function getLanguage() {
  return lang;
}

export function isEnglish() {
  return lang === 'en';
}

// `params` fills {name} placeholders in whichever string is picked.
export function tr(ja, en, params) {
  const text = lang === 'en' && en != null ? en : ja;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m));
}

const STATIC_ATTRS = [
  ['title', 'enTitle', 'jaTitle'],
  ['aria-label', 'enAriaLabel', 'jaAriaLabel'],
  ['placeholder', 'enPlaceholder', 'jaPlaceholder'],
];

export function applyStaticTranslations(root = document) {
  document.documentElement.lang = lang;
  for (const node of root.querySelectorAll('[data-en]')) {
    if (node.dataset.ja == null) node.dataset.ja = node.textContent;
    node.textContent = lang === 'en' ? node.dataset.en : node.dataset.ja;
  }
  for (const node of root.querySelectorAll('[data-en-html]')) {
    if (node.dataset.jaHtml == null) node.dataset.jaHtml = node.innerHTML;
    node.innerHTML = lang === 'en' ? node.dataset.enHtml : node.dataset.jaHtml;
  }
  for (const [attr, enKey, jaKey] of STATIC_ATTRS) {
    for (const node of root.querySelectorAll(`[data-en-${attr}]`)) {
      if (node.dataset[jaKey] == null) node.dataset[jaKey] = node.getAttribute(attr) || '';
      node.setAttribute(attr, lang === 'en' ? node.dataset[enKey] : node.dataset[jaKey]);
    }
  }
}

// Municipality names stay Japanese in both languages (the boundary data has
// no reliable romanization); prefecture names get their English form.
const PREFECTURE_NAMES_EN = [
  null,
  'Hokkaido', 'Aomori', 'Iwate', 'Miyagi', 'Akita', 'Yamagata', 'Fukushima',
  'Ibaraki', 'Tochigi', 'Gunma', 'Saitama', 'Chiba', 'Tokyo', 'Kanagawa',
  'Niigata', 'Toyama', 'Ishikawa', 'Fukui', 'Yamanashi', 'Nagano',
  'Gifu', 'Shizuoka', 'Aichi', 'Mie',
  'Shiga', 'Kyoto', 'Osaka', 'Hyogo', 'Nara', 'Wakayama',
  'Tottori', 'Shimane', 'Okayama', 'Hiroshima', 'Yamaguchi',
  'Tokushima', 'Kagawa', 'Ehime', 'Kochi',
  'Fukuoka', 'Saga', 'Nagasaki', 'Kumamoto', 'Oita', 'Miyazaki', 'Kagoshima', 'Okinawa',
];

// Rewrites `.name` on prefecture records ({code, name}) in place to the
// current language, remembering the Japanese original in `.nameJa`. Prefecture
// names are display-only (everything keys off `code`), so localizing the
// shared records once — and again on a language switch — covers every view
// that reads them (aggregates, breadcrumb, tooltips, chronology, stats).
export function localizePrefectureRecords(records) {
  for (const r of records || []) {
    if (!r) continue;
    if (r.nameJa == null) r.nameJa = r.name;
    r.name = lang === 'en' ? PREFECTURE_NAMES_EN[r.code] || r.nameJa : r.nameJa;
  }
}

export async function setLanguage(next) {
  lang = (await bridge.setLanguage(next)) === 'en' ? 'en' : 'ja';
  applyStaticTranslations();
  return lang;
}

// Number/date formatting locale for toLocaleString and friends.
export function numberLocale() {
  return lang === 'en' ? 'en-US' : 'ja-JP';
}
