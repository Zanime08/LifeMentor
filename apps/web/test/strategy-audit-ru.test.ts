import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditWarningText, horizonLabel } from '../src/lib/strategy-ru';

/**
 * The connectivity audit on the Strategy screen (req. 45).
 *
 * `strategy.audit()` returns English sentences for the AI and the export plus a code with the numbers
 * behind each one; the screen words them. This test reads the engine's source and demands a wording
 * for every warning it can produce, so a new one can never appear on the screen as English text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const engine = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'strategy', 'strategy.ts'), 'utf8');

function auditCodes(): string[] {
  const start = engine.indexOf('async audit(');
  const body = engine.slice(start, engine.indexOf('\n  }', start));
  return [...new Set([...body.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

describe('strategy audit wording', () => {
  it('words every warning the engine can produce, in Russian', () => {
    const codes = auditCodes();
    expect(codes.length).toBeGreaterThan(2);
    for (const code of codes) {
      const text = auditWarningText({
        code,
        params: { horizon: '3mo', parent: '1y', count: 2 },
      });
      expect(text, `код без русской формулировки: ${code}`).toBeTruthy();
      expect(/[а-яё]/i.test(text!), `«${code}» не переведён: ${text}`).toBe(true);
      // the horizon is named in the user's language, not by its key
      expect(text, code).not.toContain('3mo');
    }
  });

  it('names horizons in Russian and skips an unknown code', () => {
    expect(horizonLabel('3-5y')).toBe('3–5 лет');
    expect(auditWarningText({ code: 'brand_new_warning' })).toBeNull();
  });
});
