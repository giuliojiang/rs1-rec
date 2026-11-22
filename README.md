# rs1-rec

Private choir recording browser. GitHub Pages compatible, no build step.

All audio is encrypted with AES-256-GCM (PBKDF2-SHA256, 20M iterations)
and decrypted in the browser only after entering the PIN.
The vault salt, iteration count and probe string are in `app.js`
(and mirrored in `tools/encrypt.mjs`). The PIN itself is never stored
in this repo — never commit it anywhere.

## Adding a session

1. Add plaintext tracks under `recordings/<folder-name>/`, e.g.
   `recordings/2026 mercato 1/`.
2. Encrypt them (PIN comes from your own notes, via env var only):

       RS1_PIN=xxxxxx node tools/encrypt.mjs recordings/<folder-name>/*.mp3

   This writes `<name>.mp3.enc` next to each file. Then delete the
   plaintext `.mp3` files so only `.enc` files ship.
3. Add the `probe.enc` once (only needed for a new repo):

       RS1_PIN=xxxxxx node tools/encrypt.mjs --probe

4. Rebuild the folder list:

       npm run rebuild

5. Commit only `.enc` files, `probe.enc` and `manifest.json`
   (plus code changes), never any `.mp3` plaintext or the PIN.

## Local test

    cd rs1-rec
    python3 -m http.server 8000
    # open http://localhost:8000 and enter the PIN
