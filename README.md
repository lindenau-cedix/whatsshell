# whatsapp-shell-bot

Ein produktionsreifer WhatsApp-Bot als **systemd-Service** für **Ubuntu 22.04+ /
Debian 12+**. Er erlaubt vorab freigegebenen Telefonnummern, vorab
freigegebene Shell-Kommandos auf dem Server auszuführen — mit vollständigem
Audit-Logging.

> ⚠️ **WhatsApp-ToS-Warnung**: Die Nutzung von unofficial Clients (wie
> `whatsapp-web.js`) verstößt gegen die WhatsApp-Geschäftsbedingungen. Dein
> Account kann temporär oder dauerhaft gesperrt werden. Dieses Tool ist nur
> für private, nicht-kommerzielle Setups gedacht.

---

## Inhaltsverzeichnis

- [Voraussetzungen](#voraussetzungen)
- [Installation](#installation)
- [Erstmalige Inbetriebnahme (QR-Scan)](#erstmalige-inbetriebnahme-qr-scan)
- [Konfiguration](#konfiguration)
- [Whitelist verwalten](#whitelist-verwalten)
- [SMS via Twilio](#sms-via-twilio)
- [Update-Prozess](#update-prozess)
- [Sicherheitshinweise](#sicherheitshinweise)
- [Deinstallation](#deinstallation)
- [Troubleshooting](#troubleshooting)

---

## Voraussetzungen

- Ubuntu 22.04 LTS oder neuer, oder Debian 12 oder neuer
- Root-Zugriff (für Installation)
- Internetzugang (für WhatsApp-Web-Socket)
- Ein zweites Endgerät mit WhatsApp (zum Scannen des QR-Codes)

Ausgehende Verbindungen, die der Bot aufbaut:

| Host                         | Zweck                |
|------------------------------|----------------------|
| `web.whatsapp.com`           | WebSocket-Endpoint   |
| `mmg.whatsapp.com`           | Multimedia-Upload    |
| `media.githubusercontent.com` | (nur bei updates)    |
| `deb.nodesource.com`         | (nur bei Installation)|

---

## Installation

### Option A — aus dem Git-Repo

```bash
git clone <repo-url> /tmp/whatsshell
cd /tmp/whatsshell
sudo bash scripts/install.sh
```

### Option B — per curl-Pipe (falls als Einzel-Tarball verfügbar)

```bash
curl -fsSL https://example.com/install.sh | sudo bash
```

Das Install-Script:

1. Installiert `apt`-Abhängigkeiten (Chromium für Puppeteer, System-Libs).
2. Installiert Node.js 20 via NodeSource.
3. Legt einen dedizierten System-User `wabot` an.
4. Kopiert die App nach `/opt/whatsapp-shell-bot/`.
5. Installiert npm-Dependencies mit `npm ci --omit=dev`.
6. Generiert eine initiale `config.json` aus `config.example.json`.
7. Installiert und aktiviert die systemd-Unit.

> ⚠️ Der Service startet **nicht** automatisch. Du musst zuerst deine
> Nummer(n) in der Whitelist eintragen und den Service dann manuell starten.

---

## Erstmalige Inbetriebnahme (QR-Scan)

Der WhatsApp-Web-Client muss sich **einmalig** mit deinem WhatsApp-Account
verbinden. Dazu zeigt der Bot einen QR-Code im Terminal an.

### Schritt 1 — Service stoppen (falls versehentlich gestartet)

```bash
sudo systemctl stop whatsapp-shell-bot
```

### Schritt 2 — Whitelist konfigurieren

```bash
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-command uptime "uptime" "Server-Uptime"
```

Oder direkt in `/opt/whatsapp-shell-bot/config.json` editieren — die Datei
ist `root:wabot 0640`, also als root editierbar.

### Schritt 3 — Im Vordergrund starten (für QR-Scan)

```bash
sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js
```

Im Terminal erscheint ein **großer QR-Code** (Unicode-Block-Zeichen).
Öffne auf deinem Smartphone:

> WhatsApp → Einstellungen → Verknüpfte Geräte → Gerät hinzufügen

Scanne den Code. Nach erfolgreichem Login zeigt das Terminal:

```
✅ WhatsApp verbunden als <Dein Name> (<Deine Nummer>)
```

### Schritt 4 — Vordergrund-Process beenden

Drücke `Ctrl+C`. Die Session-Credentials sind jetzt unter
`/opt/whatsapp-shell-bot/.wwebjs_auth/` gespeichert.

### Schritt 5 — Service im Hintergrund starten

```bash
sudo systemctl start whatsapp-shell-bot
sudo systemctl status whatsapp-shell-bot
```

Ab jetzt läuft der Bot dauerhaft. **Ein erneuter QR-Scan ist nach einem
Restart nicht nötig.**

---

## Konfiguration

`/opt/whatsapp-shell-bot/config.json`:

| Pfad                                | Typ           | Default          | Bedeutung |
|-------------------------------------|---------------|------------------|-----------|
| `whatsapp.sessionPath`              | string        | `.wwebjs_auth`   | Pfad für persistierte WhatsApp-Credentials |
| `whatsapp.qrRefreshSeconds`         | number        | `20`             | (ungenutzt, Refresh wird von whatsapp-web.js gesteuert) |
| `whatsapp.qrTimeoutMinutes`         | number        | `30`             | Nach dieser Zeit wird der QR-Prozess abgebrochen |
| `whatsapp.qrSmall`                  | boolean       | `true`           | `true` → kompakter QR aus Unicode-Blockzeichen (▀▄█), passt in 80 Spalten, überall sichtbar. `false` → breiter QR aus ANSI-Hintergrundfarben (~118 Spalten); bricht auf 80-Spalten-Terminals um und ist auf hellem Hintergrund unsichtbar. |
| `sms.enabled`                       | boolean       | `false`          | SMS-Kanal aktivieren |
| `sms.twilioAccountSid`              | string        | —                | Twilio Account SID (`AC…`) |
| `sms.twilioAuthToken`               | string        | —                | Twilio Auth Token (geheim!) |
| `sms.twilioPhoneNumber`             | string        | —                | Twilio-Rufnummer in E.164 mit `+` |
| `sms.webhookPath`                   | string        | `/sms/inbound`   | Lokaler Express-Pfad für den Webhook |
| `sms.httpPort`                      | number        | `3000`           | Lokaler HTTP-Port (lauscht auf 127.0.0.1) |
| `sms.httpHost`                      | string        | `127.0.0.1`      | Niemals auf `0.0.0.0` setzen! |
| `sms.validateSignature`             | boolean       | `true`           | Twilio-Signaturprüfung aktiv (Pflicht in Produktion) |
| `sms.maxOutputChars`                | number        | `1600`           | SMS-Output-Limit (Twilio segmentiert >160 Zeichen) |
| `sms.rateLimitPerMinute`            | number        | `30`             | Rate-Limit pro Quell-IP |
| `whitelist.numbers`                 | string-array  | `[]`             | Telefonnummern in E.164 **ohne** `+` |
| `whitelist.commands`                | object-array  | `[]`             | Vorab freigegebene Kommandos |
| `security.timeoutMs`                | number        | `30000`          | Max. Laufzeit pro Kommando |
| `security.maxOutputChars`           | number        | `4000`           | Output-Limit (WhatsApp) |
| `security.allowedFromGroups`        | boolean       | `false`          | (ungenutzt — Gruppen sind immer deaktiviert) |
| `logging.directory`                 | string        | `/var/log/...`   | Pfad für rotierte Audit-Logs |
| `logging.retentionDays`             | number        | `14`             | Aufbewahrungsdauer in Tagen |

> ℹ️ **Hot-Reload**: Änderungen an `config.json` werden vom laufenden
> Service per `fs.watch` automatisch erkannt. **Kein Neustart nötig.**

---

## Whitelist verwalten

Komfortabel über das Helper-Script:

```bash
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh list
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh add-command docker-ps "docker ps" "Laufende Container"
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh remove-number 491701234567
sudo /opt/whatsapp-shell-bot/scripts/update-whitelist.sh remove-command docker-ps
```

Das Script validiert das JSON, legt ein Backup an und korrigiert
Ownership/Permissions.

### Whitelist-Modell

Die Whitelist ist **kanal-übergreifend**: eine Nummer, die in
`whitelist.numbers` steht, kann denselben Befehl sowohl per WhatsApp als
auch per SMS triggern. Wir halten das absichtlich einfach — eine Nummer
identifiziert eine Person, der Kanal ist nur ein Transport.

> ℹ️ Wenn du **kanal-spezifische** Whitelists brauchst, trag dieselbe
> Nummer einfach zweimal ein (z.B. `491701234567` für WhatsApp,
> eine andere für SMS-only) und verwalte sie über
> `add-number`/`remove-number`.

---

## SMS via Twilio

Der gleiche Bot akzeptiert SMS über **Twilio Programmable Messaging** und
schickt die Antwort auf demselben Kanal zurück. Die Whitelist und das
Audit-Logging sind geteilt — eine SMS von einer whitelisted Nummer löst
denselben Befehl aus wie eine WhatsApp-Nachricht.

### Schritt 1 — Twilio-Account einrichten

1. Auf <https://www.twilio.com/try-twilio> registrieren.
2. In der Twilio-Konsole: **Phone Numbers → Manage → Buy a number** —
   eine DE-Nummer mit Voice- und **SMS-Fähigkeit** wählen.
3. **Account SID** und **Auth Token** notieren (Konsolen-Dashboard).
4. Optional für den Ersttest: **Twilio Sandbox** aktivieren. Sandbox-
   Nummern haben US-Vorwahl (`+1…`) und sind kostenlos. Webhook-URL
   format: `https://bot.example.com/sms/inbound`.

### Schritt 2 — Webhook konfigurieren

In der Twilio-Konsole: **Phone Numbers → Active Numbers → Deine Nummer →
Configuration**:

- "A MESSAGE COMES IN" → **Webhook** → `https://<deine-domain>/sms/inbound`
- HTTP-Methode: **POST**
- Speichern.

### Schritt 3 — Credentials in `config.json` eintragen

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

> ⚠️ **`httpHost` muss `127.0.0.1` bleiben.** Der Service lauscht nur
> lokal. Twilio erreicht ihn **niemals direkt** — immer über den
> Reverse-Proxy mit HTTPS.

### Schritt 4 — Reverse-Proxy mit HTTPS einrichten

**Pflicht-Voraussetzung**, sonst funktioniert Twilio nicht (kein
HTTPS = keine gültige Signatur). Drei empfohlene Optionen:

#### Option A — Caddy (einfachste Variante)

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

Caddy besorgt das Let's-Encrypt-Zertifikat automatisch.

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

> ⚠️ **`proxy_pass_request_body on` ist kritisch.** Twilio signiert den
> **Original-Body**. Wenn nginx ihn umschreibt oder wegfiltert, schlägt
> die Signaturprüfung fehl.

#### Option C — Cloudflare Tunnel (kein offener Port nötig)

```bash
# cloudflared installieren (siehe https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
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

Cloudflare terminiert HTTPS und setzt die X-Forwarded-Header automatisch.

### Schritt 5 — Testen

```bash
sudo systemctl restart whatsapp-shell-bot
sudo journalctl -u whatsapp-shell-bot -f
```

Von einer **whitelisted Nummer** eine SMS an die Twilio-Nummer schicken.
Im Log solltest du sehen:

```
info: executed   channel=sms sender=491701234567 command=uptime
info: command_result channel=sms exitCode=0 durationMs=12
info: sms_reply_sent to=491701234567 length=23
```

### Sandbox-Modus

Für den Ersttest ohne echte DE-Nummer kannst du die **Twilio Sandbox**
nutzen:

1. In der Konsole: **Messaging → Try it out → Twilio Sandbox**.
2. Sandbox-Nummer ist `+1 415 523 8886` (US).
3. Du musst von deinem Handy aus einmalig `join <keyword>` an die
   Sandbox-Nummer schicken.
4. Webhook-URL bleibt dieselbe; Twilio sendet die Sandbox-SMS an
   deinen Bot.

Sandbox-Nummern sind kostenlos und ideal zum Testen. Für den
Produktivbetrieb brauchst du eine echte DE-Nummer.

### GDPR / DSGVO-Hinweis

**Jede eingehende SMS wird im Audit-Log unter
`/var/log/whatsapp-shell-bot/whatsapp-shell-bot-*.log` gespeichert.**
Das gilt auch für Nachrichten von nicht-whitelisted Nummern (diese
werden mit `unknown_number` geloggt, aber **nicht** beantwortet).

Standard-Retention: **14 Tage**. Stelle sicher, dass das deinen
Datenschutzpflichten genügt — bei strengeren Anforderungen reduziere
`logging.retentionDays` in `config.json`. `winston-daily-rotate-file`
löscht ältere Dateien dann automatisch.

### Long-SMS

Twilio segmentiert SMS >160 Zeichen (GSM-7) bzw. >70 Zeichen (UCS-2) in
mehrere Einzel-SMS — du zahlst pro Segment, der Empfänger sieht es als
eine Nachricht. Für lange Outputs empfehlen wir
`sms.maxOutputChars = 1600`, der Executor truncate mit
`[…gekürzt…]`-Marker.

### Deaktivierung

`"sms": { "enabled": false }` setzen und `systemctl restart`. Der
HTTP-Server startet dann nicht mehr, WhatsApp funktioniert unverändert.

---

---

## Update-Prozess

```bash
cd /opt/whatsapp-shell-bot
sudo git pull                 # oder neuen Tarball entpacken
sudo bash scripts/install.sh  # idempotent — überschreibt nur was nötig ist
sudo systemctl restart whatsapp-shell-bot
```

`install.sh` ist **idempotent**: Es überschreibt vorhandene Konfiguration
nur, wenn du das explizit erlaubst.

---

## Sicherheitshinweise

### Architektur

- **Dedizierter Service-User `wabot`** (kein Login, kein Home-Verzeichnis).
- **systemd-Hardening aktiv**: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, Capability-Drop, kein SUID/SGID, keine Namespaces,
  kein Realtime-Scheduling, Locked Personality.
- **`MemoryDenyWriteExecute`** ist bewusst **deaktiviert** — Chromium's
  V8-JIT braucht W^X-disabled Memory-Mappings und würde sonst sofort
  crashen. Stattdessen verlassen wir uns auf `NoNewPrivileges` und die
  Capability-Drops.

### Whitelist-Validierung

- Kommandos müssen **exakt** einem Eintrag in `whitelist.commands`
  entsprechen.
- Verboten: `;`, `&`, `|`, `` ` ``, `$`, `>`, `<`, `*`, `?`, `(`, `)`,
  `{`, `}`, `\\`, Newlines, Tabs.
- Ausführung läuft über `child_process.execFile` — **keine Shell**, kein
  String-Interpretation. Selbst wenn die Whitelist kompromittiert wäre,
  würde keine Shell-Injection möglich sein.

### Audit-Trail

Jede eingehende Nachricht (akzeptiert oder abgelehnt) wird unter
`/var/log/whatsapp-shell-bot/whatsapp-shell-bot-YYYY-MM-DD.log` geloggt:

```json
{
  "level":"info",
  "message":"executed",
  "sender":"491701234567",
  "command":"uptime",
  "body":"uptime"
}
```

Logs rotieren täglich, Aufbewahrung: 14 Tage (konfigurierbar).

### Ausgehende Verbindungen

Der Bot baut von sich aus nur Verbindungen zu WhatsApp-Servern und zur
Twilio-API auf. Es findet **keine** ungewollte Datenübertragung statt.
Es gibt auch keine Update-Checks oder Telemetrie.

| Host                    | Zweck                       |
|-------------------------|-----------------------------|
| `web.whatsapp.com`      | WhatsApp-WebSocket          |
| `mmg.whatsapp.com`      | WhatsApp-Multimedia-Upload  |
| `api.twilio.com`        | SMS-Antworten via REST      |

### SMS-spezifische Hardening-Maßnahmen

- **`httpHost: 127.0.0.1`** — der SMS-Server lauscht **niemals** auf
  öffentlichen Interfaces. Nur der Reverse-Proxy darf ihn erreichen.
- **Twilio-Signaturprüfung** ist standardmäßig aktiv
  (`sms.validateSignature = true`). Bei `false` loggt der Service alle
  60 Sekunden eine Warnung — du wirst nicht übersehen, dass die
  Prüfung aus ist.
- **`helmet`** + **`express-rate-limit`** (30 Req/Min/IP) auf dem
  Webhook. Brute-Force-Versuche gegen die URL werden dadurch
  geblockt.
- **systemd-Hardening:** `RestrictAddressFamilies=AF_INET AF_INET6
  AF_UNIX` — exotische Socket-Familien sind gesperrt.
- **Webhook-URL nur per HTTPS** — Twilio weigert sich, an HTTP-
  Endpoints zu posten (bzw. die Signaturprüfung schlägt fehl).

### Was dieses Tool **nicht** kann

- Keine Datei-Uploads von dir an den Bot (nur Text-Nachrichten).
- Keine Antwort an andere Nummern als die, die den Befehl gesendet haben.
- Keine Ausführung von Kommandos, die nicht in der Whitelist stehen.
- Keine Gruppeninteraktion (WhatsApp; SMS hat keine Gruppen).
- Kein direkter Empfang aus dem Internet (Reverse-Proxy pflicht).

---

## Deinstallation

```bash
sudo bash scripts/uninstall.sh           # Standard: Logs/Session bleiben
sudo bash scripts/uninstall.sh --purge  # Auch Logs löschen
sudo bash scripts/uninstall.sh --full   # Komplett entfernen (inkl. User)
```

---

## Troubleshooting

### „Kein TTY erkannt"-Fehler beim manuellen Start

Du startest den Bot im Hintergrund ohne TTY. Folge der Anleitung in der
Fehlermeldung:

```bash
sudo systemctl stop whatsapp-shell-bot
sudo -u wabot /usr/bin/node /opt/whatsapp-shell-bot/src/index.js
# QR scannen, dann Ctrl+C
sudo systemctl start whatsapp-shell-bot
```

### Chromium-Sandbox-Fehler

```
Failed to launch the browser process! ... No usable sandbox!
```

Chromium läuft als unprivilegierter User, kann aber seinen eigenen Sandbox-
User nicht anlegen, weil `PrivateUsers=true` oder ähnliche Optionen in
der systemd-Unit das verhindern. Wir verwenden deshalb explizit
`--no-sandbox` in den Puppeteer-Args (siehe `src/auth.js`). Wenn du eine
stärkere Sandbox willst, kannst du `chrome-sandbox` manuell einrichten,
aber das ist außerhalb des Scopes dieses Setups.

### Fehlende Libraries

```
error while loading shared libraries: libnss3.so ...
```

→ Install-Script erneut ausführen, es installiert alle nötigen Pakete:

```bash
sudo bash scripts/install.sh
```

### WhatsApp-Ban-Warnung

Wenn du zu oft QR-Codes anforderst oder die Verbindung in verdächtigen
Mustern abreißt, kann WhatsApp deinen Account temporär oder dauerhaft
sperren. Das ist eine **Risiko-Inkaufnahme** bei der Nutzung von
`whatsapp-web.js`. Empfehlung: nur auf einem separaten Zweitaccount
verwenden.

### Service startet nicht — `journalctl` zeigt Fehler

```bash
sudo journalctl -u whatsapp-shell-bot -n 100 --no-pager
```

Häufige Ursachen:

- `config.json` ist ungültiges JSON → mit `jq . /opt/whatsapp-shell-bot/config.json` prüfen.
- Pfad `/var/log/whatsapp-shell-bot` existiert nicht → `sudo mkdir -p /var/log/whatsapp-shell-bot && sudo chown wabot:wabot /var/log/whatsapp-shell-bot`.
- Chromium-Binary nicht gefunden → `which chromium` (sollte `/usr/bin/chromium` zurückgeben). Falls anders: `Environment=PUPPETEER_EXECUTABLE_PATH=/pfad/zu/chromium` in der Unit setzen.

### Hot-Reload der Whitelist funktioniert nicht

```bash
sudo journalctl -u whatsapp-shell-bot -f | grep -i config
```

Du solltest `Konfiguration zur Laufzeit neu geladen.` sehen. Falls nicht:
fs.watch kann auf manchen Dateisystemen (z.B. NFS) unzuverlässig sein.
Workaround: `sudo systemctl restart whatsapp-shell-bot`.

### SMS: Twilio-Webhooks liefern 403

Im Log steht `sms_signature_invalid`. Ursachen (in Reihenfolge der
Wahrscheinlichkeit):

1. **Reverse-Proxy schreibt den Body um.** Twilio signiert den
   exakten Body. nginx braucht `proxy_pass_request_body on`, Caddy
   default ist OK. Bei Cloudflare-Tunnel: `httpHostHeader`-Setting
   prüfen.
2. **`X-Forwarded-Proto` / `X-Forwarded-Host` fehlen.** Der Service
   baut die öffentliche URL aus diesen Headern. Ohne sie hasht Twilio
   gegen `http://127.0.0.1:3000/...`, was nicht zur Twilio-Sicht
   (`https://bot.example.com/...`) passt.
3. **Falscher Auth Token.** Überprüfe den Token in `config.json` —
   er muss exakt dem Token aus der Twilio-Konsole entsprechen.

### SMS: Twilio sendet, aber keine Antwort kommt

1. Im Log nach `sms_reply_sent` suchen. Fehlt der Eintrag, ist die
   Command-Ausführung gescheitert.
2. Wenn `sms_reply_sent` mit einem Error kommt: Twilio-Credentials
   prüfen (Account SID, Auth Token, From-Nummer im E.164-Format).
3. Twilio-Konsole → **Monitor → Logs → Errors** zeigt HTTP-Fehler
   der ausgehenden SMS.

### SMS: Service startet nicht mit `sms.enabled=true`

```bash
sudo journalctl -u whatsapp-shell-bot -n 50 --no-pager
```

Häufigste Ursache: `twilioAccountSid` / `twilioAuthToken` /
`twilioPhoneNumber` fehlen in `config.json`. Der Service failt
bewusst **closed** — wenn SMS explizit angefordert wurde und nicht
booten kann, startet der ganze Service nicht (sonst hätte der Admin
stillschweigend nur noch WhatsApp).

---

## Lizenz

MIT

## Mitwirkende

Dieses Projekt ist absichtlich klein gehalten. Pull Requests willkommen —
bitte mit Tests.