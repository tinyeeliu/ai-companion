import { derived, get, writable } from 'svelte/store';
import en from './en';
import type { Dict } from './types';

export type { Dict } from './types';

export interface LocaleOption {
  code: string;
  name: string;
}

/** Native names, ordered like the rest of the workspace: en, Chinese, then the rest. */
export const LOCALES: LocaleOption[] = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'zh-HK', name: '繁體中文（香港）' },
  { code: 'zh-TW', name: '繁體中文（台灣）' },
  { code: 'ar', name: 'العربية' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'th', name: 'ไทย' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ur', name: 'اردو' },
  { code: 'vi', name: 'Tiếng Việt' },
];

const SUPPORTED = new Set(LOCALES.map((item) => item.code));
const RTL = new Set(['ar', 'ur']);
const STORAGE_KEY = 'companion.locale';

const dicts: Record<string, Dict> = { en };

/** Lazily loaded so only the active locale ships in the initial bundle. */
const loaders: Record<string, () => Promise<{ default: Dict }>> = {
  'zh-CN': () => import('./zh-CN'),
  'zh-HK': () => import('./zh-HK'),
  'zh-TW': () => import('./zh-TW'),
  ar: () => import('./ar'),
  bn: () => import('./bn'),
  de: () => import('./de'),
  es: () => import('./es'),
  fr: () => import('./fr'),
  hi: () => import('./hi'),
  id: () => import('./id'),
  it: () => import('./it'),
  ja: () => import('./ja'),
  ko: () => import('./ko'),
  ms: () => import('./ms'),
  pt: () => import('./pt'),
  ru: () => import('./ru'),
  th: () => import('./th'),
  tr: () => import('./tr'),
  ur: () => import('./ur'),
  vi: () => import('./vi'),
};

export const locale = writable('en');

export function isSupported(code: string): boolean {
  return SUPPORTED.has(code);
}

export function isRtl(code: string): boolean {
  return RTL.has(code);
}

/** Match "zh_hk", "en-US", "pt-BR" … against a supported locale code. */
export function matchLocale(input: string | null | undefined): string | null {
  if (input == null || input === '') return null;
  const normalized = String(input).replace(/_/g, '-').toLowerCase();
  const sorted = [...SUPPORTED].sort((a, b) => b.length - a.length);
  for (const code of sorted) {
    if (normalized === code.toLowerCase()) return code;
  }
  for (const code of sorted) {
    if (normalized.startsWith(`${code.toLowerCase()}-`)) return code;
  }
  const base = normalized.split('-')[0] ?? '';
  if (base === 'zh') {
    if (normalized.includes('hans')) return 'zh-CN';
    if (normalized.includes('hant')) return 'zh-TW';
    if (normalized.includes('hk')) return 'zh-HK';
    return 'zh-CN';
  }
  return SUPPORTED.has(base) ? base : null;
}

function savedLocale(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw != null && SUPPORTED.has(raw) ? raw : null;
  } catch {
    return null;
  }
}

function browserLocale(): string | null {
  if (typeof navigator === 'undefined') return null;
  for (const lang of [navigator.language, ...(navigator.languages ?? [])]) {
    const match = matchLocale(lang);
    if (match != null) return match;
  }
  return null;
}

function detectInitialLocale(): string {
  return savedLocale() ?? browserLocale() ?? 'en';
}

function applyDocumentLocale(code: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = code;
  document.documentElement.dir = isRtl(code) ? 'rtl' : 'ltr';
}

async function ensureDict(code: string): Promise<void> {
  if (code === 'en' || dicts[code] != null) return;
  const load = loaders[code];
  if (load == null) return;
  try {
    const mod = await load();
    dicts[code] = mod.default;
  } catch {
    /* keep the English fallback */
  }
}

export async function setLocale(code: string): Promise<void> {
  if (!SUPPORTED.has(code)) return;
  await ensureDict(code);
  locale.set(code);
  applyDocumentLocale(code);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore persistence failures */
  }
}

/** Detect the initial language and load its dictionary. Call once at startup. */
export function initLocale(): void {
  const code = detectInitialLocale();
  applyDocumentLocale(code);
  if (code === 'en') {
    locale.set('en');
    return;
  }
  void ensureDict(code).then(() => locale.set(code));
}

function lookup(code: string, key: string): string | undefined {
  const value = dicts[code]?.[key];
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

export function resolve(code: string, key: string, vars?: Record<string, unknown>): string {
  let text = lookup(code, key) ?? en[key] ?? key;
  if (vars != null) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value ?? ''));
    }
  }
  return text;
}

export type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** Reactive translator for templates: `{$tr('app.ready')}`. */
export const tr = derived(locale, ($locale): Translate => (key, vars) => resolve($locale, key, vars));

/** Non-reactive translator for event handlers and confirm dialogs. */
export function t(key: string, vars?: Record<string, unknown>): string {
  return resolve(get(locale), key, vars);
}
