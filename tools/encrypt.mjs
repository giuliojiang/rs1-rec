// Encrypts plaintext recordings with the same vault as the browser app.
// Usage: RS1_PIN=xxxxxx node tools/encrypt.mjs <file.mp3> [<file2.mp3> ...]
//        RS1_PIN=xxxxxx node tools/encrypt.mjs --probe
// Reads the PIN from the RS1_PIN environment variable — never hard-code it.
// Writes "<file>.enc" next to each input (IV(12) || ciphertext+tag), same
// format the browser decrypts. The vault salt/iterations below must match app.js.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { webcrypto } from 'crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// MUST match app.js — if you change one, change the other.
const VAULT_SALT = 'fd133808a8e34abd69bf5d4c08f6efeb';
const VAULT_ITERATIONS = 20000000;
const PROBE_TEXT = 'rs1-vault-probe::ok';
const PROBE_OUT = path.join(root, 'probe.enc');

const pin = process.env.RS1_PIN;
if (!pin) {
  console.error('Missing RS1_PIN env var (e.g. RS1_PIN=123456 node tools/encrypt.mjs file.mp3)');
  process.exit(1);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey() {
  const km = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(VAULT_SALT), iterations: VAULT_ITERATIONS, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

async function encryptBuffer(key, data) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return Buffer.from(out);
}

async function main() {
  const args = process.argv.slice(2);
  console.log('Deriving key (PBKDF2 x' + VAULT_ITERATIONS + ')…');
  const key = await deriveKey();

  if (args.length === 0) {
    console.error('Usage: RS1_PIN=xxxxxx node tools/encrypt.mjs <file.mp3> [...]  |  --probe');
    process.exit(1);
  }

  if (args.includes('--probe')) {
    const enc = await encryptBuffer(key, new TextEncoder().encode(PROBE_TEXT));
    fs.writeFileSync(PROBE_OUT, enc);
    console.log('Wrote probe.enc (' + enc.length + ' bytes)');
    return;
  }

  for (const file of args) {
    const input = path.resolve(file);
    if (!fs.existsSync(input)) {
      console.error('Not found: ' + input);
      process.exit(1);
    }
    console.log('Encrypting ' + input + ' …');
    const data = fs.readFileSync(input);
    const enc = await encryptBuffer(key, data);
    const out = input.endsWith('.enc') ? input : input + '.enc';
    fs.writeFileSync(out, enc);
    console.log('  -> ' + out + ' (' + enc.length + ' bytes, was ' + data.length + ')');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
