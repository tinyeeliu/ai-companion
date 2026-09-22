/**
 * Guards the translated dictionaries: every locale must define every key, keep
 * the same `{placeholder}` set as English, and leave nothing blank.
 */
import { describe, expect, test } from 'bun:test';
import en from './en';
import { check } from './check';

const LOCALES = [
  'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
  'ms', 'pt', 'ru', 'th', 'tr', 'ur', 'vi', 'zh-CN', 'zh-HK', 'zh-TW',
];

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

const dicts = new Map<string, Record<string, string>>([
  ['en', en as Record<string, string>],
]);
for (const code of LOCALES) {
  dicts.set(code, (await import(`./${code}`)).default as Record<string, string>);
}

describe('i18n dictionaries', () => {
  test('every key the source requests is defined, and all locales agree', async () => {
    expect(await check()).toEqual([]);
  });

  test('no locale has a blank string', () => {
    for (const [code, dict] of dicts) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value.trim(), `${code}.${key} is blank`).not.toBe('');
      }
    }
  });

  test('no locale leaks an untranslated dotted key as its value', () => {
    for (const [code, dict] of dicts) {
      for (const [key, value] of Object.entries(dict)) {
        if (code === 'en') continue;
        // A value identical to a key name means someone pasted a fallback.
        expect(value, `${code}.${key} looks like a raw key`).not.toMatch(
          /^(nav|page|table|common|detail|history|cloud|status)\.[a-zA-Z.]+$/,
        );
      }
    }
  });

  test('placeholders match English exactly', () => {
    for (const [code, dict] of dicts) {
      if (code === 'en') continue;
      for (const [key, english] of Object.entries(en)) {
        const expected = placeholders(english);
        if (expected.length === 0) continue;
        expect(placeholders(dict[key]!), `${code}.${key} placeholder drift`).toEqual(expected);
      }
    }
  });

  test('the states we just fixed are present in every locale', () => {
    const required = [
      'cloud.connected', 'cloud.connecting', 'cloud.retrying', 'cloud.rejected', 'cloud.off',
      'nav.phones', 'nav.home', 'nav.rail', 'nav.menu', 'nav.health',
      'page.received.title', 'page.sent.title', 'table.rename', 'common.cancel',
      'detail.forwardToken', 'detail.forwardTokenPlaceholder', 'detail.renameTitle',
      'history.reply', 'history.replyContext',
    ];
    for (const [code, dict] of dicts) {
      for (const key of required) {
        expect(dict[key], `${code} is missing ${key}`).toBeTruthy();
      }
    }
  });
});
