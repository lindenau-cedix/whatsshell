# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`whatsapp-shell-bot` is a Node.js 20 / systemd service that lets a small whitelist of phone numbers execute a small whitelist of shell commands on the host. Two channels: **WhatsApp** (via `whatsapp-web.js` + headless Chromium) and **SMS** (via Twilio Programmable Messaging, gated behind a local Express + reverse-proxy-with-HTTPS setup). Daily-rotating JSON audit logs. Runs as a dedicated `wabot` user with a hardened systemd unit. See `README.md` for operator-facing documentation (install, QR pairing, Twilio setup, reverse-proxy configs, troubleshooting).

## Common commands

```bash
# Syntax-check every JS file (incl. channels/)
for f in src/*.js src/channels/*.js; do node --check "$f"; done

# Run the full test suite (65 tests, ~1s)
node --test test/

# Run one file
node --test test/sms.test.js

# Validate JSON
node -e "JSON.parse(require('fs').readFileSync('package.json'))"

# Bash syntax-check the scripts
for f in scripts/*.sh; do bash -n "$f"; done

# Install on a target host (must run as root)
sudo bash scripts/install.sh

# Boot the bot in foreground (TTY required for QR pairing)
sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js

# Tail the service
sudo journalctl -u whatsapp-shell-bot -f
```

There is no build step, no bundler, no linter, no formatter — `node --check` plus the test suite is the whole quality gate.

## Architecture

Eight modules under `src/` (counting `src/channels/`) with a strict layering — every module below depends only on modules at the same or a higher layer, never the other way:

```
index.js                  ← entry point, boots WhatsApp client AND (if sms.enabled) SMS HTTP server
  ├── logger.js           ← winston init (file + optional console transport)
  ├── auth.js             ← builds whatsapp-web.js Client, renders QR to TTY
  ├── shutdown.js         ← SIGTERM/SIGINT handler, child reaping, client.destroy(), registered cleanups
  ├── router.js           ← CHANNEL-AGNOSTIC message handler: filter → validate → execute → reply
  │     ├── whitelist.js  ← string matching, forbidden-char regex, group detection
  │     └── executor.js   ← child_process.execFile + hand-rolled tokenizer
  └── channels/
        ├── whatsapp.js   ← normalises msg → router.handleMessage, group filter, msg.reply() wrapper
        └── sms.js        ← Express app + Twilio signature check + REST reply
```

Both channels call into `router.handleMessage({channel, from, body, reply, metadata})`. The router has zero knowledge of WhatsApp or SMS — it just runs whitelist lookup → executor → reply closure → log.

### Key decisions (each is justified in a `Decision:` comment near the code)

- **`child_process.execFile`, not `exec`.** No shell is spawned, so even if the whitelist were bypassed, no shell metacharacter would be interpreted. `whitelist.js` is the *first* line of defence; `execFile` is the second.
- **Hand-rolled command tokenizer in `executor.js`.** Pulling in `shell-quote` for one security-critical helper is overkill, and keeping the tokenizer under our own eyes lets the tests pin its behaviour exactly.
- **Hot config reload via `fs.watch` with 250ms debounce.** Editors emit multiple events per save; the debounce avoids racing reloads. The WhatsApp client is never restarted — only the whitelist swaps in.
- **Foreground mode requires a TTY.** `assertTTY()` in `auth.js` exits with a precise operator message if `process.stdout.isTTY` is false on first boot, because the QR code has nowhere to go. Once a session exists in `.wwebjs_auth/`, the systemd-managed background start skips the TTY check.
- **`MemoryDenyWriteExecute` is omitted from the systemd unit.** Chromium's V8 JIT needs W^X-disabled mappings and crashes immediately under that directive. The README explains; the unit has a comment to the same effect.
- **Shutdown goes through `requestShutdown()`, never `process.exit()`.** Running `exec` children must be reaped, the SMS HTTP server closed, and the WhatsApp client destroyed before Node exits, otherwise you leak Chromium processes. `index.js` installs a single `uncaughtException` handler that funnels through this path. The SMS server is closed via `registerCleanup()` (ordered chain, awaited).
- **`config.json` is owned `root:wabot 0640`.** The running service can read but not write its own config — preventing runtime self-mutation. Only the admin (via `update-whitelist.sh` or direct edit) can change it.
- **SMS server listens on `127.0.0.1` only.** A reverse proxy with HTTPS (Caddy / nginx / Cloudflare Tunnel — see README) is mandatory. The service is **never** directly reachable from the public internet.
- **SMS webhook signature is validated against the *public* URL.** `buildPublicUrl()` reconstructs the URL Twilio actually saw from `X-Forwarded-Proto` + `X-Forwarded-Host`. Without those headers, every signature fails. Twilio's `validateRequest()` is called against the reconstructed URL, not the localhost URL Express sees.
- **SMS reply is fire-and-forget TwiML + async REST.** The webhook must ack within Twilio's 15s timeout, so we reply 200 `<Response/>` immediately and send the real reply via `client.messages.create()` AFTER the command finishes.
- **Voice reply is fire-and-forget TwiML ack + async `calls.update({twiml})` injection.** Empty `<Response/>` TwiML would hang up the call immediately, so the voice webhook returns a `<Say>` envelope (≈1.5s "Bitte warten.") to keep the call alive while the command runs; the real reply is injected via `client.calls(callSid).update({twiml})` after the command finishes.
- **`voice.command` is validated against `whitelist.commands` at boot** (`src/channels/voice.js`). If the configured command isn't in the whitelist, `createVoiceApp` throws and the service refuses to start — same fail-closed stance as SMS. `client.calls(...).update()` failures with codes `13231` (call ended) and `20404` (CallSid gone) are benign (caller hung up) — log warn, not error.
- **SMS is fail-closed at boot.** If `sms.enabled=true` but credentials are missing or `createSmsChannel()` throws, the whole service exits — so the admin never silently ends up with WhatsApp-only after thinking SMS is on.

### Test layout

`test/whitelist.test.js` is the most important file for understanding the security model — every rejection reason (`empty`, `not_a_string`, `forbidden_chars`, `multiline`, `unknown_command`) is exercised by name. If you change `whitelist.js` or the `FORBIDDEN_PATTERN`, extend this file in the same patch.

`test/router.test.js` calls `router.handleMessage()` directly with a fake `reply()` closure — no real WhatsApp client is involved. `test/executor.test.js` runs `printf`, `false`, `sleep`, and `seq` against the real `execFile` path. `test/sms.test.js` mounts the SMS Express app on `http.createServer()` (NOT `app.listen()` — keep-alive sockets would prevent the test runner from exiting) and round-trips real Twilio signatures via `getExpectedTwilioSignature()`. `test/whatsapp-channel.test.js` covers `extractSender()`.

## Gotchas when editing

- The `whatsapp-web.js` Client emits `qr` events with the *same* payload until it rotates (~20s). `auth.js` throttles re-renders to avoid flicker. If you change the render path, keep the throttle.
- `whatsapp-web.js` exposes the sender as `msg.from` in E.164 form with `@c.us` (1:1) or `@g.us` (group) suffix. After the SMS refactor, `extractSender()` and `isGroupMessage()` live in `src/channels/whatsapp.js` (not `router.js` or `whitelist.js`) — group filtering is a WhatsApp-specific concern.
- The systemd unit expects Chromium at `/usr/bin/chromium` via `PUPPETEER_EXECUTABLE_PATH`. If you change the package source, update both the unit file and `install.sh`.
- `scripts/install.sh` is idempotent and runs as root. It uses `rsync --delete` to mirror the project tree into `/opt/whatsapp-shell-bot/`, excluding `node_modules`, `.git`, `.wwebjs_auth`, logs, and any existing `config.json`. `src/channels/` is covered automatically — `chmod 750 src` is recursive.
- Twilio's webhook signature algorithm requires the **exact** POST body in the hash. nginx needs `proxy_pass_request_body on`; Caddy and Cloudflare Tunnel pass through by default. README → "SMS: Twilio-Webhooks liefern 403" for diagnosis steps.
- `sms.maxOutputChars` defaults to 1600 (vs WhatsApp's 4000). Twilio segments >160-char messages, so longer caps cost more per send. The executor's truncate marker (`[…gekürzt…]`) is channel-agnostic.