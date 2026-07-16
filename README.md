# whatsapp-shell-bot

A production-ready WhatsApp bot running as a **systemd service** on
**Ubuntu 22.04+ / Debian 12+**. It allows pre-approved phone numbers to
execute pre-approved shell commands on the server — with full audit
logging.

> ⚠️ **WhatsApp ToS Warning**: Using unofficial clients (such as
> `whatsapp-web.js`) violates WhatsApp's terms of service. Your account
> may be temporarily or permanently banned. This tool is intended only
> for private, non-commercial setups.

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [First-Time Setup (QR Scan)](#first-time-setup-qr-scan)
- [Configuration](#configuration)
- [Managing the Whitelist](#managing-the-whitelist)
- [SMS via Twilio](#sms-via-twilio)
- [Voice via Twilio](#voice-via-twilio)
- [Update Process](#update-process)
- [Security Notes](#security-notes)
- [Uninstallation](#uninstallation)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- Ubuntu 22.04 LTS or newer, or Debian 12 or newer
- Root access (for installation)
- Internet access (for the WhatsApp web socket)
- A second device with WhatsApp (to scan the QR code)

Outbound connections established by the bot:

| Host                          | Purpose                |
|-------------------------------|------------------------|
| `web.whatsapp.com`            | WebSocket endpoint     |
| `mmg.whatsapp.com`            | Multimedia upload      |
| `media.githubusercontent.com` | (only for updates)     |
| `deb.nodesource.com`          | (only for installation)|

---

## Installation

### Option A — from the git repository

```bash
git clone <repo-url> /tmp/whatsshell
cd /tmp/whatsshell
sudo bash scripts/install.sh
```

### Option B — via curl-pipe (if available as a single tarball)

```bash
curl -fsSL https://example.com/install.sh | sudo bash
```

The install script:

1. Installs `apt` dependencies (Chromium for Puppeteer, system libs).
2. Installs Node.js 20 via NodeSource.
3. Creates a dedicated system user `wabot`.
4. Copies the app to `/opt/whatsapp-shell-bot/`.
5. Installs npm dependencies via `npm ci --omit=dev`.
6. Generates an initial `config.json` from `config.example.json`.
7. Installs and enables the systemd unit.

> ⚠️ The service does **not** start automatically. You must first add
> your number(s) to the whitelist and then start the service manually.

---

## First-Time Setup (QR Scan)

The WhatsApp web client must connect to your WhatsApp account **once**.
To do this, the bot displays a QR code in the terminal.

### Step 1 — Stop the service (if started by accident)

```bash
sudo systemctl stop whatsapp-shell-bot
```

### Step 2 — Configure the whitelist

```bash
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-command uptime "uptime" "Server uptime"
```

Or edit `/opt/whatsapp-shell-bot/config.json` directly — the file is
owned `root:wabot 0640`, so it's editable as root.

### Step 3 — Start in foreground (for QR scan)

```bash
sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js
```

A **large QR code** (Unicode block characters) will appear in the
terminal. On your smartphone, open:

> WhatsApp → Settings → Linked Devices → Add Device

Scan the code. After successful login, the terminal shows:

```
✅ WhatsApp connected as <Your Name> (<Your Number>)
```

### Step 4 — End the foreground process

Press `Ctrl+C`. The session credentials are now stored in
`/opt/whatsapp-shell-bot/.wwebjs_auth/`.

### Step 5 — Start the service in the background

```bash
sudo systemctl start whatsapp-shell-bot
sudo systemctl status whatsapp-shell-bot
```

From now on the bot runs permanently. **A new QR scan is not required
after a restart.**

---

## Configuration

`/opt/whatsapp-shell-bot/config.json`:

| Path                          | Type           | Default          | Description |
|-------------------------------|----------------|------------------|-------------|
| `whatsapp.sessionPath`        | string         | `.wwebjs_auth`   | Path for persisted WhatsApp credentials |
| `whatsapp.qrRefreshSeconds`   | number         | `20`             | (unused, refresh is controlled by whatsapp-web.js) |
| `whatsapp.qrTimeoutMinutes`   | number         | `30`             | The QR process is aborted after this time |
| `whatsapp.qrSmall`            | boolean        | `true`           | `true` → compact QR using Unicode block characters (▀▄█), fits in 80 columns, visible everywhere. `false` → wider QR using ANSI background colors (~118 columns); wraps on 80-column terminals and is invisible on light backgrounds. |
| `sms.enabled`                 | boolean        | `false`          | Enable SMS channel |
| `sms.twilioAccountSid`        | string         | —                | Twilio Account SID (`AC…`) |
| `sms.twilioAuthToken`         | string         | —                | Twilio Auth Token (secret!) |
| `sms.twilioPhoneNumber`       | string         | —                | Twilio phone number in E.164 with `+` |
| `sms.webhookPath`             | string         | `/sms/inbound`   | Local Express path for the webhook |
| `sms.httpPort`                | number         | `3000`           | Local HTTP port (listens on 127.0.0.1) |
| `sms.httpHost`                | string         | `127.0.0.1`      | Never set to `0.0.0.0`! |
| `sms.validateSignature`       | boolean        | `true`           | Twilio signature check active (required in production) |
| `sms.maxOutputChars`          | number         | `1600`           | SMS output limit (Twilio segments at >160 chars) |
| `sms.rateLimitPerMinute`      | number         | `30`             | Rate limit per source IP |
| `voice.enabled`               | boolean        | `false`          | Enable voice channel (Twilio Programmable Voice) |
| `voice.twilioAccountSid`      | string         | —                | Twilio Account SID — can be identical to `sms.twilioAccountSid` |
| `voice.twilioAuthToken`       | string         | —                | Twilio Auth Token (secret!) — can be identical to `sms.twilioAuthToken` |
| `voice.twilioPhoneNumber`     | string         | —                | **Dedicated** Twilio phone number for Voice (with voice capability) |
| `voice.webhookPath`           | string         | `/voice/inbound` | Local Express path for the voice webhook |
| `voice.httpPort`              | number         | `3001`           | Local HTTP port (separate from the SMS port) |
| `voice.httpHost`              | string         | `127.0.0.1`      | Never set to `0.0.0.0`! |
| `voice.validateSignature`     | boolean        | `true`           | Twilio signature check active (required in production) |
| `voice.maxOutputChars`        | number         | `500`            | TTS output limit (Twilio `<Say>` caps at 4000) |
| `voice.rateLimitPerMinute`    | number         | `30`             | Rate limit per source IP |
| `voice.ackPauseSeconds`       | number         | `35`             | Quiet hold time after "Please wait" before the result is injected via TwiML (1–600 seconds) |
| `voice.command`               | string         | —                | **One** whitelist command line that runs on every call. Must be identical to a `whitelist.commands[*].command` — otherwise the service refuses to start. |
| `whitelist.numbers`           | string-array   | `[]`             | Phone numbers in E.164 **without** `+` |
| `whitelist.commands`          | object-array   | `[]`             | Pre-approved commands |
| `security.timeoutMs`          | number         | `30000`          | Max execution time per command |
| `security.maxOutputChars`     | number         | `4000`           | Output limit (WhatsApp) |
| `security.allowedFromGroups`  | boolean        | `false`          | (unused — groups are always disabled) |
| `logging.directory`           | string         | `/var/log/...`   | Path for rotated audit logs |
| `logging.retentionDays`       | number         | `14`             | Retention period in days |

> ℹ️ **Hot reload**: Changes to `config.json` are detected automatically
> by the running service via `fs.watch`. **No restart required.**

---

## Managing the Whitelist

Conveniently via the helper script:

```bash
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh list
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-command docker-ps "docker ps" "Running containers"
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh remove-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh remove-command docker-ps
```

The script validates the JSON, creates a backup, and fixes ownership
and permissions.

### Whitelist Model

The whitelist is **channel-agnostic**: a number listed in
`whitelist.numbers` can trigger the same command both via WhatsApp and
via SMS. We intentionally keep it simple — a number identifies a
person, the channel is just transport.

> ℹ️ If you need **channel-specific** whitelists, simply add the same
> number twice (e.g. `491701234567` for WhatsApp, a different one for
> SMS-only) and manage them via `add-number`/`remove-number`.

---

## SMS via Twilio

The same bot accepts SMS via **Twilio Programmable Messaging** and
sends the reply back through the same channel. The whitelist and audit
logging are shared — an SMS from a whitelisted number triggers the
same command as a WhatsApp message.

### Step 1 — Set up a Twilio account

1. Register at <https://www.twilio.com/try-twilio>.
2. In the Twilio console: **Phone Numbers → Manage → Buy a number** —
   pick a DE number with voice and **SMS capability**.
3. Note the **Account SID** and **Auth Token** (console dashboard).
4. Optional for initial testing: enable the **Twilio Sandbox**. Sandbox
   numbers have a US country code (`+1…`) and are free. Webhook URL
   format: `https://bot.example.com/sms/inbound`.

### Step 2 — Configure the webhook

In the Twilio console: **Phone Numbers → Active Numbers → Your Number →
Configuration**:

- "A MESSAGE COMES IN" → **Webhook** → `https://<your-domain>/sms/inbound`
- HTTP method: **POST**
- Save.

### Step 3 — Add credentials to `config.json`

```json
{
  "sms": {
    "enabled": true,
    "twilioAccountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "twilioAuthToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "twilioPhoneNumber": "+491234567890",
    "webhookPath": "/sms/inbound",
    "httpPort": 3000,
    "httpHost": "127.0.0.1",
    "validateSignature": true
  }
}
```

> ⚠️ **`httpHost` must remain `127.0.0.1`.** The service only listens
> locally. Twilio **never** reaches it directly — always via the
> reverse proxy with HTTPS.

### Step 4 — Set up a reverse proxy with HTTPS

**Mandatory requirement**, otherwise Twilio won't work (no HTTPS = no
valid signature). Three recommended options:

#### Option A — Caddy (simplest)

`/etc/caddy/Caddyfile`:

```
bot.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host  {host}
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains the Let's Encrypt certificate automatically.

#### Option B — nginx + certbot

`/etc/nginx/sites-available/whatsapp-shell-bot`:

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    location /sms/inbound {
        proxy_pass http://127.0.0.1:3000/sms/inbound;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_pass_request_body on;
    }
}
```

```bash
sudo certbot --nginx -d bot.example.com
sudo systemctl reload nginx
```

> ⚠️ **`proxy_pass_request_body on` is critical.** Twilio signs the
> **original body**. If nginx rewrites or filters it away, signature
> verification will fail.

#### Option C — Cloudflare Tunnel (no open port required)

```bash
# Install cloudflared (see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
cloudflared tunnel create wabot
cloudflared tunnel route dns wabot bot.example.com

# /etc/cloudflared/config.yml
cat > /etc/cloudflared/config.yml <<EOF
tunnel: wabot
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: bot.example.com
    service: http://127.0.0.1:3000
    originRequest:
      httpHostHeader: bot.example.com
  - service: http_status:404
EOF

cloudflared tunnel run wabot
```

Cloudflare terminates HTTPS and sets the `X-Forwarded-*` headers
automatically.

### Step 5 — Test

```bash
sudo systemctl restart whatsapp-shell-bot
sudo journalctl -u whatsapp-shell-bot -f
```

Send an SMS from a **whitelisted number** to the Twilio number. In the
log you should see:

```
info: executed   channel=sms sender=491701234567 command=uptime
info: command_result channel=sms exitCode=0 durationMs=12
info: sms_reply_sent to=491701234567 length=23
```

### Sandbox Mode

For initial testing without a real DE number you can use the **Twilio
Sandbox**:

1. In the console: **Messaging → Try it out → Twilio Sandbox**.
2. Sandbox number is `+1 415 523 8886` (US).
3. From your phone, send `join <keyword>` to the sandbox number once.
4. The webhook URL stays the same; Twilio forwards the sandbox SMS to
   your bot.

Sandbox numbers are free and ideal for testing. For production use
you need a real DE number.

### GDPR / DSGVO Note

**Every incoming SMS is stored in the audit log under
`/var/log/whatsapp-shell-bot/whatsapp-shell-bot-*.log`.** This also
applies to messages from non-whitelisted numbers (these are logged
with `unknown_number`, but **not** answered).

Default retention: **14 days**. Make sure this matches your data
protection obligations — for stricter requirements, reduce
`logging.retentionDays` in `config.json`. `winston-daily-rotate-file`
will then automatically delete older files.

### Long SMS

Twilio segments SMS longer than 160 characters (GSM-7) or 70
characters (UCS-2) into multiple individual SMS — you pay per segment,
the recipient sees it as one message. For long outputs we recommend
`sms.maxOutputChars = 1600`; the executor truncates with the
`[…truncated…]` marker.

### Disabling

Set `"sms": { "enabled": false }` and `systemctl restart`. The HTTP
server will no longer start, WhatsApp keeps working unchanged.

---

## Voice via Twilio

A call to the configured Twilio phone number executes **a single
pre-defined command** and reads the result aloud via TTS.
"Voice mode" is therefore a kind of status hotline: call, wait briefly,
hear uptime / Docker status / etc., hang up.

The whitelist is the same as for WhatsApp and SMS. SMS and voice
channels can be active simultaneously — the voice webhook runs on a
**separate HTTP port** (`voice.httpPort`, default `3001`), so both
reverse proxy paths remain independent.

### Step 1 — Buy a Twilio number with voice capability

1. Register at <https://www.twilio.com/try-twilio> (if you haven't
   already).
2. **Phone Numbers → Manage → Buy a number** — pick a DE number that
   has **voice capability** (listed with "Voice" checked). Pure SMS
   numbers don't work for voice.
3. Note the Account SID and Auth Token (the same as for SMS is fine —
   account credentials are not number-specific).

### Step 2 — Define the voice command in `config.json`

`voice.command` is the exact command string that runs on every call —
and **must** be identical to an entry in `whitelist.commands`,
otherwise the service refuses to start (fail-closed).

```json
{
  "voice": {
    "enabled": true,
    "twilioAccountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "twilioAuthToken": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "twilioPhoneNumber": "+499876543210",
    "webhookPath": "/voice/inbound",
    "httpPort": 3001,
    "httpHost": "127.0.0.1",
    "validateSignature": true,
    "maxOutputChars": 500,
    "ackPauseSeconds": 35,
    "command": "uptime"
  },
  "whitelist": {
    "commands": [
      { "name": "uptime", "command": "uptime", "description": "Server uptime" }
    ]
  }
}
```

> ⚠️ `voice.command` must match exactly one of
> `whitelist.commands[*].command` — including case and arguments. If
> there's a typo, the service won't start and the log will contain
> `voice.command "..." is not in whitelist.commands`.

### Step 3 — Configure the inbound voice webhook

In the Twilio console: **Phone Numbers → Active Numbers → Your Voice
Number → Configuration**:

- **"A CALL COMES IN"** → **Webhook** → `https://<your-domain>/voice/inbound`
- HTTP method: **POST**
- Save.

> ⚠️ Don't confuse this with **"A MESSAGE COMES IN"** — that's the
> SMS webhook. The voice number requires a separate entry under "A
> CALL COMES IN", otherwise no call will reach you.

### Step 4 — Extend the reverse proxy with the voice route

The reverse proxy must forward `/voice/inbound` to port `3001`.
Example for **Caddy**:

```
bot.example.com {
    reverse_proxy /sms/inbound 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host  {host}
    }
    reverse_proxy /voice/inbound 127.0.0.1:3001 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host  {host}
    }
}
```

For **nginx**, add a second `location` block for `/voice/inbound` that
proxies to `127.0.0.1:3001` analogous to `/sms/inbound`. Cloudflare
Tunnel: a second `ingress` rule with `service: http://127.0.0.1:3001`.

> ⚠️ **Both routes need `X-Forwarded-*` headers**, otherwise Twilio
> signature verification will fail — Twilio hashes the public URL, not
> `http://127.0.0.1:3001/...`.

### Step 5 — Test

```bash
sudo systemctl restart whatsapp-shell-bot
sudo journalctl -u whatsapp-shell-bot -f
```

From a **whitelisted number**, call the Twilio voice number. You'll
hear "Please wait." and then the TTS result (e.g. "OK. 14:32, up 5
days …"). In the log:

```
info: voice_reply_sent  callSid=CAxxxx length=68
```

A call from a **non-whitelisted number** → the call ends immediately
with "Please wait.", no command runs, no TTS output. The log contains
`unknown_number`.

### How It Works (Architecture)

1. Twilio sends `POST /voice/inbound` with `CallSid`, `From`, …
2. The service verifies the Twilio signature against the public URL
   (reconstructed from `X-Forwarded-*`).
3. The service replies **immediately** with `<Response><Say>Please wait.</Say>
   <Pause length="35"/></Response>`. `<Say>` provides instant feedback;
   `<Pause>` keeps the call silently open afterwards until the result
   is injected. The pause length comes from `voice.ackPauseSeconds`
   (`35` is the default).
4. In parallel, the configured command runs via `child_process.execFile`
   (no shell, as everywhere else).
5. When the command finishes, the service calls
   `client.calls(callSid).update({twiml: '<Response><Say>...</Say></Response>'})`.
   Twilio speaks the TwiML **mid-call** — the caller typically waits
   1–3 seconds before the result arrives.

### Cost Note

Twilio charges for call duration per started minute (DE number
typically ~€0.01–0.02/minute). A typical status call lasts 20–60
seconds (TTS reads ~12 characters/second). For many calls per day, it's
worth keeping an eye on the Twilio billing.

### Disabling

Set `"voice": { "enabled": false }` and `systemctl restart`. The voice
HTTP server will no longer start, WhatsApp and SMS keep working
unchanged.

For accepted calls, the pause must be longer than
`security.timeoutMs` plus a few seconds of REST buffer. The default
`35` matches the standard timeout of 30 seconds. Higher values keep
the call open longer if `calls.update` fails and may incur additional
cost.

### Voice-Specific Gotchas

- **The ack needs `<Say>` plus `<Pause>`.** `<Say>` alone is done after
  speaking; Twilio would then end the TwiML document and hang up.
  `<Pause>` keeps the call open for `voice.ackPauseSeconds` so that
  `client.calls(callSid).update` can inject the result.
- **`voice.command` must match the whitelist.** Otherwise the service
  won't start (fail-closed).
- **Call hangs up immediately after "Please wait." /
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in the log:** The reverse proxy
  sets `X-Forwarded-For`, but Express must trust this loopback hop in
  order for `express-rate-limit` to determine the client IP. The
  channel sets `app.set('trust proxy', 'loopback')` for this (the
  server listens on `127.0.0.1`, the proxy connects locally). Affects
  SMS and voice equally. No action needed unless the error reappears
  after your own changes.
- **Hot reload of the whitelist works, but `voice.command`,
  `voice.httpPort`, `voice.webhookPath`, `voice.twilioPhoneNumber`
  require a `systemctl restart`** — same as with the SMS channel.
- **Caller hangs up before command ends:** `client.calls(callSid).update`
  fails with Twilio code `13231` (call ended) or `20404` (CallSid
  gone). This is logged as a warning, not an error.

---

## Update Process

```bash
cd /opt/whatsapp-shell-bot
sudo git pull                 # or extract a new tarball
sudo bash scripts/install.sh  # idempotent — only overwrites what's needed
sudo systemctl restart whatsapp-shell-bot
```

> ⚠️ `install.sh` deliberately leaves an existing
> `/opt/whatsapp-shell-bot/config.json` unchanged. After an update with
> new features (e.g. voice), compare `config.example.json` with your
> existing configuration and manually add new blocks/options. If the
> `voice` block is missing, the channel is treated as disabled and no
> listener starts on `voice.httpPort`.

`install.sh` is **idempotent**: it only overwrites existing
configuration if you explicitly allow it.

---

## Security Notes

### Architecture

- **Dedicated service user `wabot`** (no login, no home directory).
- **systemd hardening enabled**: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, capability drop, no SUID/SGID, no namespaces, no
  realtime scheduling, locked personality.
- **`MemoryDenyWriteExecute`** is deliberately **disabled** —
  Chromium's V8 JIT needs W^X-disabled memory mappings and would
  crash immediately otherwise. We instead rely on `NoNewPrivileges`
  and the capability drops.

### Whitelist Validation

- Commands must match **exactly** an entry in `whitelist.commands`.
- Forbidden: `;`, `&`, `|`, `` ` ``, `$`, `>`, `<`, `*`, `?`, `(`,
  `)`, `{`, `}`, `\\`, newlines, tabs.
- Execution runs through `child_process.execFile` — **no shell**, no
  string interpretation. Even if the whitelist were compromised, no
  shell injection would be possible.

### Audit Trail

Every incoming message (accepted or rejected) is logged under
`/var/log/whatsapp-shell-bot/whatsapp-shell-bot-YYYY-MM-DD.log`:

```json
{
  "level":"info",
  "message":"executed",
  "sender":"491701234567",
  "command":"uptime",
  "body":"uptime"
}
```

Logs rotate daily, retention: 14 days (configurable).

### Outbound Connections

The bot only connects on its own to WhatsApp servers and the Twilio
API. **No** unwanted data transfer takes place. There are also no
update checks or telemetry.

| Host               | Purpose                      |
|--------------------|------------------------------|
| `web.whatsapp.com` | WhatsApp WebSocket           |
| `mmg.whatsapp.com` | WhatsApp multimedia upload   |
| `api.twilio.com`   | SMS replies via REST         |

### SMS-Specific Hardening

- **`httpHost: 127.0.0.1`** — the SMS server **never** listens on
  public interfaces. Only the reverse proxy may reach it.
- **Twilio signature verification** is active by default
  (`sms.validateSignature = true`). When `false`, the service logs a
  warning every 60 seconds — you won't miss that verification is off.
- **`helmet`** + **`express-rate-limit`** (30 req/min/IP) on the
  webhook. Brute-force attempts against the URL are thereby blocked.
- **systemd hardening:** `RestrictAddressFamilies=AF_INET AF_INET6
  AF_UNIX` — exotic socket families are blocked.
- **Webhook URL only via HTTPS** — Twilio refuses to POST to HTTP
  endpoints (or signature verification fails).

### What This Tool **Cannot** Do

- No file uploads from you to the bot (text messages only).
- No replies to numbers other than the one that sent the command.
- No execution of commands not in the whitelist.
- No group interaction (WhatsApp; SMS has no groups).
- No direct reception from the internet (reverse proxy required).

---

## Uninstallation

```bash
sudo bash scripts/uninstall.sh           # Default: logs/session are kept
sudo bash scripts/uninstall.sh --purge  # Also delete logs
sudo bash scripts/uninstall.sh --full   # Completely remove (incl. user)
```

---

## Troubleshooting

### "No TTY detected" error on manual start

You're starting the bot in the background without a TTY. Follow the
instructions in the error message:

```bash
sudo systemctl stop whatsapp-shell-bot
sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js
# Scan QR, then Ctrl+C
sudo systemctl start whatsapp-shell-bot
```

### Chromium Sandbox Error

```
Failed to launch the browser process! ... No usable sandbox!
```

Chromium runs as an unprivileged user but cannot create its own
sandbox user because `PrivateUsers=true` or similar options in the
systemd unit prevent this. We therefore explicitly use `--no-sandbox`
in the Puppeteer args (see `src/auth.js`). If you want a stronger
sandbox, you can set up `chrome-sandbox` manually, but that's outside
the scope of this setup.

### Missing Libraries

```
error while loading shared libraries: libnss3.so ...
```

→ Re-run the install script, it installs all needed packages:

```bash
sudo bash scripts/install.sh
```

### WhatsApp Ban Warning

If you request QR codes too often or the connection drops in
suspicious patterns, WhatsApp may temporarily or permanently ban
your account. This is an **accepted risk** when using
`whatsapp-web.js`. Recommendation: only use it on a separate
secondary account.

### Service doesn't start — `journalctl` shows errors

```bash
sudo journalctl -u whatsapp-shell-bot -n 100 --no-pager
```

Common causes:

- `config.json` is invalid JSON → check with
  `jq . /opt/whatsapp-shell-bot/config.json`.
- Path `/var/log/whatsapp-shell-bot` doesn't exist →
  `sudo mkdir -p /var/log/whatsapp-shell-bot && sudo chown wabot:wabot /var/log/whatsapp-shell-bot`.
- Chromium binary not found → `which chromium` (should return
  `/usr/bin/chromium`). If different: set
  `Environment=PUPPETEER_EXECUTABLE_PATH=/path/to/chromium` in the unit.

### Hot Reload of the Whitelist Doesn't Work

```bash
sudo journalctl -u whatsapp-shell-bot -f | grep -i config
```

You should see `Configuration reloaded at runtime.` If not:
`fs.watch` can be unreliable on some file systems (e.g. NFS).
Workaround: `sudo systemctl restart whatsapp-shell-bot`.

### SMS: Twilio webhooks return 403

The log shows `sms_signature_invalid`. Causes (in order of
probability):

1. **Reverse proxy rewrites the body.** Twilio signs the exact body.
   nginx needs `proxy_pass_request_body on`, Caddy default is fine.
   For Cloudflare Tunnel: check the `httpHostHeader` setting.
2. **`X-Forwarded-Proto` / `X-Forwarded-Host` are missing.** The
   service builds the public URL from these headers. Without them,
   Twilio hashes against `http://127.0.0.1:3000/...`, which doesn't
   match Twilio's view (`https://bot.example.com/...`).
3. **Wrong Auth Token.** Verify the token in `config.json` — it must
   match exactly the token from the Twilio console.

### SMS: Twilio sends, but no reply arrives

1. Search the log for `sms_reply_sent`. If the entry is missing, the
   command execution failed.
2. If `sms_reply_sent` comes with an error: check Twilio credentials
   (Account SID, Auth Token, From number in E.164 format).
3. Twilio console → **Monitor → Logs → Errors** shows HTTP errors
   of outgoing SMS.

### SMS: Service doesn't start with `sms.enabled=true`

```bash
sudo journalctl -u whatsapp-shell-bot -n 50 --no-pager
```

Most common cause: `twilioAccountSid` / `twilioAuthToken` /
`twilioPhoneNumber` are missing in `config.json`. The service
deliberately fails **closed** — when SMS is explicitly requested but
can't boot, the entire service won't start (otherwise the admin
would silently be left with WhatsApp-only).

### Voice: "An application error has occurred"

This announcement comes from Twilio when the **initial voice webhook**
doesn't deliver a usable 2xx TwiML response. First check the HTTP
status in Twilio under **Monitor → Logs → Calls → Debug Events**:

1. **502 / 504 / error 11200:** The reverse proxy can't reach the
   local voice server. Check:

   ```bash
   sudo systemctl --no-pager --full status whatsapp-shell-bot
   sudo journalctl -u whatsapp-shell-bot -n 100 --no-pager
   sudo ss -ltnp | grep ':3001'
   ```

   The journal must contain `Voice HTTP server listening on
   127.0.0.1:3001/voice/inbound`. If the listener is missing, first
   check whether the current code is installed and whether
   `/opt/whatsapp-shell-bot/config.json` contains a `voice` block with
   `enabled: true`. With Cloudflare Tunnel, the public host must
   point to `http://127.0.0.1:3001`.
2. **403:** Look in the journal for `voice_signature_invalid`. The
   logged `publicUrl` must match Twilio's webhook URL exactly. Then
   check `X-Forwarded-Proto`, `X-Forwarded-Host`, unmodified POST
   body, and Auth Token. Don't disable `voice.validateSignature`
   permanently.
3. **200, "Please wait" audible, but no result:** Search the journal
   for `voice_ack_sent`, `command_result`, `voice_reply_sent`, or
   `Voice reply failed`. `13231`/`20404` means the call ended before
   the result could be injected. For commands close to the timeout,
   raise `voice.ackPauseSeconds` appropriately (max 600) or use a
   faster command.
4. **No voice log entry:** Twilio is likely using the wrong URL/path
   or method. Under **A CALL COMES IN**, the webhook must be
   `https://<domain>/voice/inbound` with method **POST**.

### Voice: Call hangs up immediately / no TTS

1. **Check the Twilio console:** is "A CALL COMES IN" set to the
   correct `/voice/inbound` URL? Is the number **voice-capable**?
2. **Reverse proxy** must forward `/voice/inbound` to `127.0.0.1:3001`
   (or the configured `voice.httpPort`). See Caddy / nginx snippets
   in "Voice via Twilio" above.
3. **Signature verification** fails → log contains
   `voice_signature_invalid`. Causes are identical to the SMS issue:
   `X-Forwarded-*` headers missing, or the body is being modified by
   the reverse proxy.
4. **Service won't start** with `voice.enabled=true` and
   `voice.command: "xyz"`: check whether `"xyz"` is exactly listed in
   `whitelist.commands`. Fail-closed: the service doesn't boot on
   typos.
5. **TTS doesn't arrive:** if the caller hangs up or
   `voice.ackPauseSeconds` expires before the command finishes, the
   call is already ended (see `voice_reply_sent` missing in the log).
   For longer commands, raise the ack pause accordingly, lower
   `security.timeoutMs`, or replace `voice.command` with a faster
   command.

---

## License

MIT

## Contributing

This project is intentionally kept small. Pull requests welcome —
please include tests.