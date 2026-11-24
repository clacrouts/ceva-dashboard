// The site's languages: the list for the picker, the locale used to format numbers and name countries,
// the writing direction, and the loading of a page's text (English underneath, so a missing translation
// shows in English rather than breaking the page).
export const LANGUAGES = [
  ["en", "English"], ["fr", "Français"], ["de", "Deutsch"], ["es", "Español"], ["it", "Italiano"],
  ["pt", "Português"], ["ro", "Română"], ["zh", "中文"], ["hi", "हिन्दी"], ["ar", "العربية"],
];
const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-PT", ro: "ro-RO",
  zh: "zh-CN", hi: "hi-IN", ar: "ar" };
const RIGHT_TO_LEFT = new Set(["ar"]);
const CODES = new Set(LANGUAGES.map(([code]) => code));

export const locale = (lang) => LOCALES[lang] || lang;
export const direction = (lang) => (RIGHT_TO_LEFT.has(lang) ? "rtl" : "ltr");

// ?lang=xx, then the visitor's last choice, then the browser's languages, then English.
export function initialLanguage() {
  const asked = new URLSearchParams(location.search).get("lang");
  if (CODES.has(asked)) return asked;
  try {
    const kept = localStorage.getItem("ceva-lang");
    if (CODES.has(kept)) return kept;
  } catch { /* storage may be blocked */ }
  for (const wanted of navigator.languages || [navigator.language || "en"]) {
    const code = String(wanted).slice(0, 2).toLowerCase();
    if (CODES.has(code)) return code;
  }
  return "en";
}

export function keepLanguage(lang) {
  try { localStorage.setItem("ceva-lang", lang); } catch { /* storage may be blocked */ }
}

function merge(base, over) {
  if (over === undefined) return base;
  if (base && over && typeof base === "object" && typeof over === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value);
    return out;
  }
  return over;
}

const loaded = new Map();
// kind is "map" or "report": assets/i18n/<kind>-<lang>.js, each exporting its text as default.
export async function loadText(kind, lang) {
  const key = `${kind}-${lang}`;
  if (!loaded.has(key)) {
    const english = import(`./i18n/${kind}-en.js`).then((m) => m.default);
    const own = lang === "en" ? english : import(`./i18n/${kind}-${lang}.js`).then((m) => m.default).catch(() => ({}));
    loaded.set(key, Promise.all([english, own]).then(([en, text]) => merge(en, text)));
  }
  return loaded.get(key);
}

// Country names in the page's language (the data's English name when the browser has none).
export function countryName(code, lang, fallback) {
  try {
    return new Intl.DisplayNames([locale(lang)], { type: "region" }).of(code) || fallback || code;
  } catch {
    return fallback || code;
  }
}

export function fillLanguagePicker(select, lang) {
  select.innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}" lang="${code}">${name}</option>`).join("");
  select.value = lang;
}
