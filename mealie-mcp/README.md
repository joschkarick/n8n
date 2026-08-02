# Mealie MCP hinter Authentik

Macht [rldiao/mealie-mcp-server](https://github.com/rldiao/mealie-mcp-server)
für Claude im Web und auf dem iPhone erreichbar.

> **Zum Einrichten: [ANLEITUNG.md](ANLEITUNG.md)** – Schritt für Schritt mit den
> konkreten Hostnamen. Dieses Dokument erklärt, *warum* es so gebaut ist.

## Warum überhaupt ein Vorbau

Der Mealie-MCP-Server startet fest per stdio:

```python
mcp = FastMCP("mealie")
mcp.run(transport="stdio")
```

Kein Transport-Schalter, keine Env-Variable. Für Claude Desktop reicht das —
dort läuft er lokal als Subprozess und braucht **kein** OAuth. Für Web und
Handy braucht es dagegen einen öffentlich erreichbaren HTTPS-Endpunkt, und
Claude akzeptiert dort ausschliesslich OAuth: statische Bearer-Token oder
eigene Header sind im Connector nicht vorgesehen.

`gateway.py` erledigt beides in einem Prozess: Es importiert das FastMCP-Objekt,
lässt es als Streamable HTTP laufen und hängt einen OAuth-Resource-Server davor.

## Aufbau

```
Claude (Web/iOS)
  │  HTTPS + Bearer JWT
  ▼
NPMplus                     TLS, mealie-mcp.joschka.eu
  ▼
gateway.py                  RFC 9728 Metadata + JWT-Prüfung gegen JWKS
  ▼
mealie-mcp-server           in-process, hält den Mealie-Token
  ▼
Mealie
```

Authentik steht **neben** dem Pfad, nicht darin: Es stellt nur Tokens aus und
sieht keine einzige MCP-Anfrage. Der Mealie-API-Token bleibt im Container und
erreicht Claude nie.

## 1. Authentik

Provider anlegen, Typ **OAuth2/OpenID Provider**:

| Feld | Wert |
| --- | --- |
| Client type | `Confidential` |
| Redirect URI | `https://claude.ai/api/mcp/auth_callback` |
| Signing Key | ein RS256-Zertifikat |
| Scopes | `openid`, `profile`, `email` |

Dazu eine Application mit dem Slug `mealie-mcp` und diesem Provider.

Notiere aus dem Provider:

- **Client ID** und **Client Secret** → kommen später in Claude
- den **Issuer**, Form `https://login.joschka.eu/application/o/mealie-mcp/`

## 2. Dienst starten

```bash
cp .env.example .env
# MEALIE_API_KEY, OIDC_ISSUER und OIDC_AUDIENCE eintragen
# OIDC_AUDIENCE ist die Client-ID aus Authentik
docker compose up -d --build
docker compose logs -f mealie-mcp
```

Im Log müssen Ressource, Metadata, Issuer und Audience so stehen, wie du sie
erwartest. Der Dienst bindet sich auf `127.0.0.1:8000`; läuft NPMplus in einem
eigenen Docker-Netz, siehe die Kommentare in `docker-compose.yml`.

## 3. NPMplus

Proxy Host anlegen:

| Feld | Wert |
| --- | --- |
| Domain | `mealie-mcp.joschka.eu` |
| Scheme | `http` |
| Forward Hostname | `127.0.0.1` |
| Forward Port | `8000` |
| Websockets Support | an |
| Block Common Exploits | an |
| SSL | Let's Encrypt, Force SSL, HTTP/2 |

Unter **Advanced** eintragen — ohne das puffert nginx die Streaming-Antworten
und der Verbindungsaufbau läuft in einen Timeout:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_cache off;
chunked_transfer_encoding off;
proxy_set_header Connection '';
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Wichtig: **kein** Access-List- oder Authentik-Forward-Auth auf diesem Host.
Die Authentifizierung macht das Gateway selbst per Bearer-Token. Ein
Login-Redirect davor bricht den OAuth-Flow.

Ebenso wichtig: Der **originale Host-Header** muss durchgereicht werden.
NPMplus macht das von Haus aus. Das MCP-SDK prüft ihn gegen eine Allowlist
(Schutz vor DNS-Rebinding) und antwortet sonst mit `421 Invalid Host header`.
Der Hostname aus `PUBLIC_URL` steht automatisch drin; beim Start listet das
Log die komplette Allowlist auf.

Danach muss das hier ohne Token funktionieren:

```bash
curl -s https://mealie-mcp.joschka.eu/healthz
curl -s https://mealie-mcp.joschka.eu/.well-known/oauth-protected-resource
```

Und das hier muss **401** mit einem `WWW-Authenticate`-Header liefern:

```bash
curl -i -X POST https://mealie-mcp.joschka.eu/mcp
```

Genau dieser Header sagt Claude, wo es sich ein Token holen soll.

## 4. Claude

Auf **claude.ai im Browser** (aus der Mobile-App lassen sich keine Connectors
hinzufügen), unter Settings → Connectors → Add custom connector:

- URL: `https://mealie-mcp.joschka.eu/mcp`
- **Advanced settings**: Client ID und Client Secret aus Authentik eintragen

Das ersetzt Dynamic Client Registration, die Authentik nicht anbietet.
Nach dem Verbinden synchronisiert der Connector auf iPhone und Desktop.

## Wenn es klemmt

**„invalid_token", Audience passt nicht.** Der mit Abstand häufigste Fehler.
Claude schickt einen `resource`-Parameter nach RFC 8707; ob Authentik den in
die `aud`-Claim übernimmt, hängt an der Provider-Konfiguration. Hol dir ein
Token, dekodiere es auf jwt.io und schau, was wirklich in `aud` steht — dann
`OIDC_AUDIENCE` entsprechend setzen. Zum Eingrenzen kannst du die Prüfung
kurz abschalten, indem du die Variable leer lässt. Nicht so lassen.

**Verbindung hängt beim OAuth-Schritt.** Meist die fehlende Advanced-Config in
NPMplus, oder eine Access List auf dem Proxy Host.

**Das FastMCP-Objekt wird nicht gefunden.** Dann hat das Repo seine Struktur
geändert. Im Container nachsehen:

```bash
docker compose exec mealie-mcp python -c "import server; print(server.mcp)"
```

und den gefundenen Pfad in `gateway.py` unter `_CANDIDATES` ergänzen.

**`421 Invalid Host header`.** Der Reverse Proxy reicht einen anderen Host
durch als den aus `PUBLIC_URL`. Das Log zeigt beim Start die Allowlist und
beim Fehlversuch den tatsächlich angekommenen Host — den dann in
`EXTRA_ALLOWED_HOSTS` ergänzen.

**Container startet nicht, Fehler beim Import.** `server.py` baut die
Mealie-Verbindung schon beim Import auf (`GET /api/app/about`). Ist Mealie
nicht erreichbar oder der Token falsch, bricht der Start ab. Das ist Absicht —
so scheitert es sofort und nicht erst bei der ersten Anfrage. Prüfe
`MEALIE_BASE_URL` und `MEALIE_API_KEY` und ob der Container Mealie erreicht.

**Claude holt sich das Token, benutzt es aber nie.** Dann liegt es
wahrscheinlich nicht an dir — im Anthropic-Tracker stehen mehrere offene Bugs
zu genau diesem Muster im Connector-Flow.

## Was geprüft ist

Gegen das echte Paket (MCP-SDK 1.28.1, Python 3.12) verifiziert:

- Modul heisst `server`, `mcp` ist ein `FastMCP`, Transport fest auf stdio
- `streamable_http_app()` liefert eine Starlette-App mit Pfad `/mcp`
- Metadata und `/healthz` ohne Token erreichbar
- `/mcp` ohne Token → 401 mit korrektem `WWW-Authenticate`-Header
- falsche Audience, abgelaufenes Token, falscher Issuer → jeweils 401
- Authentik nicht erreichbar → 503, **nicht** 401
- gültiges Token → 200, Session-ID, saubere `initialize`-Antwort
- fremder Host-Header → 421

Nicht geprüft, weil dafür deine Umgebung nötig ist: der Docker-Build, der
echte Flow gegen Authentik und die NPMplus-Konfiguration.

## Erst lokal probieren

Bevor du das alles aufsetzt: Der Server läuft in **Claude Desktop** sofort,
ohne Gateway, ohne Authentik, ohne öffentliche Domain.

```json
{
  "mcpServers": {
    "mealie": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/rldiao/mealie-mcp-server.git", "mealie-mcp-server"],
      "env": {
        "MEALIE_BASE_URL": "https://mealie.joschka.eu",
        "MEALIE_API_KEY": "..."
      }
    }
  }
}
```

So merkst du in fünf Minuten, ob die 62 Tools im Alltag taugen — und ob sich
der Aufwand für Web und Handy überhaupt lohnt.
