/**
 * i18n consistency check: every key the source requests must exist in `en.ts`,
 * and every locale must define every key `en.ts` has.
 *
 * Run: bun run src/i18n/check.ts   (or `bun src/i18n/check.ts`)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import en from './en';

const SRC = new URL('..', import.meta.url).pathname;
const LOCALES = [
  'ar', 'bn', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko',
  'ms', 'pt', 'ru', 'th', 'tr', 'ur', 'vi', 'zh-CN', 'zh-HK', 'zh-TW',
];
const LOOKUP = /(?:\$?tr|\$?translate|\bt)\(\s*['"]([A-Za-z][\w.]*)['"]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export async function check(): Promise<string[]> {
  const problems: string[] = [];
  const requested = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.includes('/i18n/')) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LOOKUP)) {
      if (match[1].includes('.')) requested.add(match[1]);
    }
  }

  const defined = new Set(Object.keys(en));
  const missing = [...requested].filter((key) => !defined.has(key)).sort();
  for (const key of missing) problems.push(`en is missing a key the source requests: ${key}`);

  for (const code of LOCALES) {
    const dict = (await import(`./${code}`)).default as Record<string, string>;
    const gap = Object.keys(en).filter((key) => !(key in dict));
    if (gap.length > 0) problems.push(`${code} is missing ${gap.length} key(s): ${gap.join(', ')}`);
  }
  return problems;
}

const problems = await check();
if (problems.length === 0) {
  console.log(`i18n OK — ${Object.keys(en).length} keys in en, ${LOCALES.length} locales in sync`);
} else {
  console.error(`i18n found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
