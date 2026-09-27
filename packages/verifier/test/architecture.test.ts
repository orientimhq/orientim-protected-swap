import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '../src');
const coreSrc = join(import.meta.dirname, '../../core/src');

// The verifier may read Orientim's constants and types and nothing else of Orientim: never the compiler
// or the policy builder, so that a compiler bug cannot hide from it (plan, section 10).
const ALLOWED = [/^@solana\/kit$/, /^@solana-program\/token$/, /^@orientim\/core\/(constants|types)$/, /^\.\/[a-z]+\.ts$/];
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);

describe('verifier independence (plan, section 10)', () => {
  it('imports only kit, the token program client, Orientim constants and types, and its own files', () => {
    for (const file of readdirSync(src)) {
      expect(importsOf(join(src, file)).filter(i => !ALLOWED.some(a => a.test(i))), file).toEqual([]);
    }
  });

  it('@orientim/core does not depend on the verifier', () => {
    for (const file of readdirSync(coreSrc)) {
      expect(importsOf(join(coreSrc, file)).filter(i => i.includes('verifier')), file).toEqual([]);
    }
  });

  it('economic limits come from constants.ts, not only from the policy', () => {
    const verify = readFileSync(join(src, 'verify.ts'), 'utf8');
    for (const limit of ['MAX_FEE_BPS', 'ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS', 'MAX_LOADED_ACCOUNTS_DATA_SIZE']) {
      // imported once and used at least once
      expect(verify.split(limit).length - 1, limit).toBeGreaterThanOrEqual(2);
    }
  });
});
