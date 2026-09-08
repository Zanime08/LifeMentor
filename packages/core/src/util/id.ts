/**
 * Time-ordered UUIDv7 generator + entity id helpers.
 *
 * Ids are created **on the client**, which is what makes offline-first work:
 * two devices can create records at the same time and the ids still never collide,
 * and because they are time-ordered, indexes stay append-friendly (no page churn).
 */

const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const c: Crypto | undefined = globalThis.crypto;
  const out = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  /* Very old environments only — deterministic-quality fallback. */
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** RFC 9562 UUIDv7: 48-bit unix ms timestamp + random. */
export function uuidv7(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  // timestamp (48 bit, big endian)
  bytes[0] = (timestampMs / 2 ** 40) & 0xff;
  bytes[1] = (timestampMs / 2 ** 32) & 0xff;
  bytes[2] = (timestampMs / 2 ** 24) & 0xff;
  bytes[3] = (timestampMs / 2 ** 16) & 0xff;
  bytes[4] = (timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  // version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

export type EntityKind =
  | 'goal' | 'task' | 'event' | 'project' | 'milestone' | 'skill' | 'assessment'
  | 'node' | 'path' | 'topic' | 'review' | 'memory' | 'conversation' | 'message'
  | 'news' | 'notification' | 'snapshot' | 'op' | 'strategy' | 'field' | 'session';

/** Readable prefixed id, e.g. `task_0192f0a3-...` — helps logs and debugging. */
export function newId(kind?: EntityKind): string {
  const id = uuidv7();
  return kind ? `${kind}_${id}` : id;
}

export function isUuidLike(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Deterministic ordering for ids created in the same millisecond. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
