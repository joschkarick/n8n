# Anleitung: Mealie-MCP für Claude einrichten

Für deine Umgebung:

| Was | Wo |
| --- | --- |
| Authentik | `https://login.joschka.eu` |
| Mealie | `https://mealie.joschka.eu` |
| MCP-Endpunkt | `https://mealie-mcp.joschka.eu` |
| Reverse Proxy | NPMplus |

---

## Schritt 0 — Erst ohne all das probieren

Bevor du irgendetwas aufsetzt: In **Claude Code** und **Claude Desktop** läuft der
Mealie-MCP-Server lokal als stdio-Prozess. Kein Gateway, kein Authentik, keine
Domain, kein OAuth.

Claude Code, einmalig im Terminal:

```bash
claude mcp add mealie \
  -e MEALIE_BASE_URL=https://mealie.joschka.eu \
  -e MEALIE_API_KEY=dein-token \
  -- uvx --from git+https://github.com/rldiao/mealie-mcp-server.git mealie-mcp-server
```

Claude Desktop, in der Konfigurationsdatei:

```json
{
  "mcpServers": {
    "mealie": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/rldiao/mealie-mcp-server.git", "mealie-mcp-server"],
      "env": {
        "MEALIE_BASE_URL": "https://mealie.joschka.eu",
        "MEALIE_API_KEY": "dein-token"
      }
    }
  }
}
```

Den Token bekommst du in Mealie unter **Profil → API Tokens**.

Damit hast du in fünf Minuten alle 62 Tools am Rechner. Der ganze Rest dieser
Anleitung dient ausschliesslich dazu, dasselbe auf **claude.ai und dem iPhone**
verfügbar zu machen. Wenn dir der Rechner reicht, hör hier auf.

---

## Schritt 1 — Authentik: Provider anlegen

Admin-Oberfläche → **Applications → Providers → Create → OAuth2/OpenID Provider**

| Feld | Wert |
| --- | --- |
| Name | `mealie-mcp` |
| Authorization flow | `default-provider-authorization-explicit-consent` |
| Client type | **Confidential** |
| Redirect URIs | `https://claude.ai/api/mcp/auth_callback` |
| Signing Key | ein Zertifikat auswählen, z. B. *authentik Self-signed Certificate* |
| Scopes | `openid`, `profile`, `email` |

Zwei Felder entscheiden über Erfolg oder Misserfolg:

**Signing Key ist Pflicht.** Ohne ihn stellt Authentik kein signiertes JWT aus,
und das Gateway kann nichts gegen die JWKS prüfen. Wenn du später „invalid_token"
siehst, obwohl alles richtig aussieht — hier zuerst nachschauen.

**Client type muss Confidential sein.** Nur dann bekommst du ein Client Secret,
und genau das brauchst du in Claude, weil Authentik keine Dynamic Client
Registration anbietet.

Notiere dir **Client ID** und **Client Secret**.

## Schritt 2 — Authentik: Application anlegen

**Applications → Applications → Create**

| Feld | Wert |
| --- | --- |
| Name | `Mealie MCP` |
| Slug | `mealie-mcp` |
| Provider | der eben angelegte `mealie-mcp` |

Der Slug bestimmt den Issuer. Mit `mealie-mcp` lautet er:

```
https://login.joschka.eu/application/o/mealie-mcp/
```

Gegenprobe im Browser — das muss JSON liefern:

```
https://login.joschka.eu/application/o/mealie-mcp/.well-known/openid-configuration
```

Wenn du dort eine Fehlermeldung bekommst, stimmt der Slug nicht.

Denk daran, dir selbst über eine Policy oder Gruppe **Zugriff auf die Application**
zu geben, sonst lehnt Authentik dich später beim Login ab.

## Schritt 3 — Dienst starten

Auf dem Server, im Verzeichnis `mealie-mcp/`:

```bash
cp .env.example .env
```

In der `.env` eintragen:

```ini
MEALIE_BASE_URL=https://mealie.joschka.eu
MEALIE_API_KEY=dein-mealie-token

PUBLIC_URL=https://mealie-mcp.joschka.eu

OIDC_ISSUER=https://login.joschka.eu/application/o/mealie-mcp/
OIDC_AUDIENCE=deine-client-id-aus-schritt-1
```

Der Dienst bindet sich auf `127.0.0.1:18000` — erreichbar für NPMplus im
Host-Netz, aber nicht aus dem Internet. Ist der Port belegt, in der `.env`
`HOST_PORT` ändern; im Container bleibt es immer 8000.

```bash
ss -tlnp | grep :18000     # muss leer sein
```

Läuft dein NPMplus stattdessen in einem eigenen Docker-Netz, dann in
`docker-compose.yml` das `ports`-Mapping streichen und den `networks`-Block
aktivieren, mit dem Namen aus `docker network ls`.

Dann:

```bash
docker compose up -d --build
docker compose logs -f mealie-mcp
```

Im Log muss stehen:

```
MCP-Server geladen aus server.mcp
Ressource: https://mealie-mcp.joschka.eu/mcp
Metadata:  https://mealie-mcp.joschka.eu/.well-known/oauth-protected-resource
Issuer:    https://login.joschka.eu/application/o/mealie-mcp/
Audience:  <deine Client-ID>
Host-Allowlist: ['mealie-mcp.joschka.eu', 'mealie-mcp.joschka.eu:*', ...]
```

Startet der Container nicht, liegt es fast immer an Mealie: `server.py` baut die
Verbindung schon beim Import auf. Prüfe Token und Erreichbarkeit.

## Schritt 4 — NPMplus

`mealie-mcp.joschka.eu` ist bei dir schon registriert. Im Proxy Host:

| Feld | Wert |
| --- | --- |
| Scheme | `http` |
| Forward Hostname | `127.0.0.1` (bei NPMplus im eigenen Docker-Netz: `mealie-mcp`) |
| Forward Port | `18000` (bzw. dein `HOST_PORT`) |
| Websockets Support | an |
| Block Common Exploits | an |
| SSL | Let's Encrypt, Force SSL, HTTP/2 |

Unter **Advanced** eintragen:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
chunked_transfer_encoding off;
proxy_set_header Connection '';
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Ohne diesen Block puffert nginx die Streaming-Antworten und der
Verbindungsaufbau läuft in einen Timeout.

**Keine Access List und kein Forward-Auth auf diesem Host.** Die
Authentifizierung macht das Gateway selbst per Bearer-Token. Ein
Authentik-Login-Redirect davor bricht den OAuth-Flow — das ist verlockend, weil
du Authentik ohnehin hast, aber es ist genau falsch.

## Schritt 5 — Vor Claude gegenprüfen

Zuerst direkt auf dem Server, noch ohne Proxy:

```bash
curl -s http://127.0.0.1:18000/healthz
```

Kommt hier `{"status":"ok",...}`, läuft der Container richtig und es fehlt nur
noch NPMplus davor.

Dann von aussen — drei Aufrufe, die alle stimmen müssen:

```bash
# 1. muss 200 liefern
curl -s https://mealie-mcp.joschka.eu/healthz

# 2. muss JSON mit deinem Issuer liefern
curl -s https://mealie-mcp.joschka.eu/.well-known/oauth-protected-resource

# 3. muss 401 liefern, MIT WWW-Authenticate-Header
curl -i -X POST https://mealie-mcp.joschka.eu/mcp
```

Bei 3 muss im Header stehen:

```
WWW-Authenticate: Bearer resource_metadata="https://mealie-mcp.joschka.eu/.well-known/oauth-protected-resource", ...
```

Genau dieser Header sagt Claude, wo es sich ein Token holen soll. Fehlt er,
kommt der Connector nie über den ersten Schritt hinaus.

## Schritt 6 — Claude

Auf **claude.ai im Browser** — aus der iPhone-App lassen sich keine Connectors
hinzufügen:

**Settings → Connectors → Add custom connector**

| Feld | Wert |
| --- | --- |
| URL | `https://mealie-mcp.joschka.eu/mcp` |
| Advanced settings → OAuth Client ID | Client ID aus Schritt 1 |
| Advanced settings → OAuth Client Secret | Client Secret aus Schritt 1 |

Es folgt ein Login bei `login.joschka.eu` und die Zustimmung. Danach
synchronisiert der Connector automatisch auf iPhone und Desktop.

---

## Wenn es klemmt

### „invalid_token", Audience passt nicht

Der mit Abstand häufigste Fehler. Claude schickt einen `resource`-Parameter nach
RFC 8707; ob Authentik den in die `aud`-Claim übernimmt, hängt an der
Provider-Konfiguration.

So findest du den wahren Wert:

```bash
docker compose logs mealie-mcp | grep -i audience
```

Oder nimm dir ein Token und dekodiere es auf jwt.io — dann `OIDC_AUDIENCE`
entsprechend setzen und neu starten. Zum Eingrenzen kannst du die Prüfung kurz
abschalten, indem du die Variable leer lässt. **Nicht so lassen.**

### „invalid_token", obwohl alles richtig aussieht

Meist fehlt der **Signing Key** am Provider. Ohne ihn ist der Access Token kein
signiertes JWT.

### `421 Invalid Host header`

NPMplus reicht einen anderen Host durch als den aus `PUBLIC_URL`. Das Log zeigt
beim Start die Allowlist und beim Fehlversuch den tatsächlich angekommenen Host.
Diesen dann in `EXTRA_ALLOWED_HOSTS` ergänzen.

### `503 temporarily_unavailable`

Das Gateway erreicht `login.joschka.eu` nicht. Kein Token-Problem — prüfe, ob der
Container Authentik auflösen und erreichen kann. Bei Docker-internem DNS kann es
nötig sein, dass beide im selben Netz hängen oder Authentik über die
öffentliche Adresse erreichbar ist.

### Verbindung hängt beim OAuth-Schritt

Fast immer die fehlende Advanced-Config in NPMplus oder doch eine Access List
auf dem Proxy Host.

### Claude holt sich das Token, benutzt es aber nie

Dann liegt es wahrscheinlich nicht an dir. Im Anthropic-Tracker stehen mehrere
offene Bugs zu genau diesem Muster im Connector-Flow.

---

## Checkliste

- [ ] Provider in Authentik, Client type **Confidential**, **Signing Key gesetzt**
- [ ] Redirect URI `https://claude.ai/api/mcp/auth_callback`
- [ ] Application mit Slug `mealie-mcp`, Zugriff für dich freigegeben
- [ ] `.well-known/openid-configuration` liefert JSON
- [ ] `.env` gefüllt, Container läuft, Log zeigt die erwarteten Werte
- [ ] NPMplus: Advanced-Block gesetzt, **keine** Access List
- [ ] `/healthz` → 200, Metadata → JSON, `POST /mcp` → 401 mit `WWW-Authenticate`
- [ ] Connector auf claude.ai mit Client ID und Secret angelegt
