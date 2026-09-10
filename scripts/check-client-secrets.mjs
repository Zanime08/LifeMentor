import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Guard: the shipped clients must not contain credentials (req. 20, 58, 95).
 *
 * The Windows, Android and web clients all come from `apps/web/dist`, so one scan covers all
 * three. The rule is absolute: no provider key, no VAPID private key, no JWT secret, no service
 * account file — neither in the JavaScript, nor in the CSS, nor in a source map (a source map that
 * embeds a secret is just as public as the code).
 *
 * Everything here is pattern-based on purpose: it catches the realistic accident (someone imports
 * a `.env`, prints a key for debugging, or checks in a generated config), and it fails a build
 * instead of shipping the mistake.
 */

const RULES = [
  { name: 'OpenAI key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'JWT secret assignment', pattern: /\bJWT_SECRET\s*[=:]\s*['"]?[A-Za-z0-9_\-+/]{16,}/ },
  { name: 'VAPID private key assignment', pattern: /\bVAPID_PRIVATE_KEY\s*[=:]\s*['"]?[A-Za-z0-9_\-+/]{16,}/ },
  { name: 'Firebase service account', pattern: /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/ },
  { name: 'VAPID/FCM server secret in a data URL', pattern: /data:application\/json;base64,[A-Za-z0-9+/]{200,}/ },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.vite']);
/** Client assets are a few MB at most; anything larger is not something we ship. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Walk a directory and report every file that looks like it carries a credential. */
export function scanDirectory(directory) {
  const root = resolve(directory);
  const files = [];
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const size = statSync(path).size;
      files.push(path);
      bytes += size;
    }
  };
  walk(root);

  const findings = [];
  for (const path of files) {
    // Scan everything that is text. Detecting text by content (no NUL byte) instead of by file
    // extension matters: a stray `.pem`, `.key` or extensionless config would otherwise be skipped
    // by exactly the check that exists to catch it.
    const buffer = readFileSync(path);
    if (buffer.byteLength > MAX_SCAN_BYTES) continue;
    if (buffer.subarray(0, 8192).includes(0)) continue; // binary: icon, wasm, font, archive
    const text = buffer.toString('utf8');
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      findings.push({
        rule: rule.name,
        file: relative(root, path),
        // Never print the secret itself — the report may end up in CI logs.
        excerpt: `${match[0].slice(0, 12)}… (${match[0].length} chars)`,
      });
    }
  }
  return { root, files: files.length, bytes, findings };
}


/**
 * `--self-test`: prove the guard still detects things. A security check that silently stops
 * matching is worse than no check at all, so the patterns are exercised against throwaway files
 * (fake values only) every time the test suite runs.
 */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'lifementor-secrets-'));
  const samples = {
    'clean.js': 'const greeting = "hello"; function add(a, b) { return a + b; }',
    'openai.js': `const key = "sk-proj-${'A'.repeat(32)}";`,
    'anthropic.js': `const key = "sk-ant-${'B'.repeat(24)}";`,
    'google.js': `const key = "AIza${'C'.repeat(35)}";`,
    'jwt.js': `const env = "JWT_SECRET=0123456789abcdef0123456789abcdef";`,
    'vapid.js': `VAPID_PRIVATE_KEY=${'D'.repeat(43)}`,
    'service-account.json': `{ "private_key_id": "${'e'.repeat(32)}" }`,
    'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    'bundle.js.map': `{"sources":["../../../.env"],"mappings":"AAAA"}`,
  };
  try {
    for (const [name, content] of Object.entries(samples)) writeFileSync(join(dir, name), content, 'utf8');
    const result = scanDirectory(dir);
    const hitFiles = new Set(result.findings.map((f) => f.file));
    const expected = Object.keys(samples).filter((name) => name !== 'clean.js' && name !== 'bundle.js.map');
    const missed = expected.filter((name) => !hitFiles.has(name));
    if (hitFiles.has('clean.js')) {
      console.error('self-test failed: ordinary code was reported as a secret');
      return 1;
    }
    if (missed.length > 0) {
      console.error(`self-test failed: not detected — ${missed.join(', ')}`);
      return 1;
    }
    console.log(`self-test ok: ${result.findings.length} seeded secrets detected, clean file ignored`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv.includes('--self-test')) {
  process.exit(selfTest());
}

if (invokedDirectly) {
  const target = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'apps/web/dist');
  let result;
  try {
    result = scanDirectory(target);
  } catch (error) {
    console.error(`Cannot scan ${target}: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Build the web client first: npm run build --workspace @lifementor/web');
    process.exit(1);
  }
  const mb = (result.bytes / 1024 / 1024).toFixed(2);
  if (result.findings.length === 0) {
    console.log(`No credentials in ${result.files} client files (${mb} MB) — ${result.root}`);
    process.exit(0);
  }
  console.error(`Credential material found in the client bundle (${result.findings.length} hit(s)):`);
  for (const finding of result.findings) {
    console.error(`  • ${finding.rule} in ${finding.file} — ${finding.excerpt}`);
  }
  console.error('Client builds must never contain provider keys, JWT secrets or VAPID private keys.');
  process.exit(1);
}
