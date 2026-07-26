# Selfhosted: n8n hinter NPMplus + MCP-Server

Setup-Notizen für `n8n.joschka.eu` — Reverse Proxy, öffentliche Basis-URL und der
instanzweite MCP-Server. Entstanden beim Debuggen genau dieser Kette; die
Reihenfolge unten ist auch die sinnvolle Reihenfolge zum Aufsetzen.

## 1. Öffentliche Basis-URL (die häufigste Fehlerquelle)

n8n leitet seine öffentliche URL so ab (`packages/cli/src/services/url.service.ts`):

```
getInstanceBaseUrl()
  = N8N_EDITOR_BASE_URL
  → sonst N8N_WEBHOOK_URL / WEBHOOK_URL
  → sonst `${N8N_PROTOCOL}://${N8N_HOST}:${N8N_PORT}`
```

Die dritte Stufe hängt den Port an, sobald er nicht 443 (bei `https`) bzw. 80
(bei `http`) ist. Hinter einem Reverse Proxy ist das immer falsch: Der Listen-Port
bleibt 5678, erreichbar ist die Instanz aber über 443.

Diese URL steckt in Webhook-URLs, E-Mails **und** den OAuth-Metadaten des
MCP-Servers (`packages/cli/src/modules/oauth-server/oauth.controller.ts` —
`issuer`, `authorization_endpoint`, `registration_endpoint` hängen alle daran).
Stimmt sie nicht, scheitert die MCP-Anmeldung mit einem irreführenden
Registrierungsfehler.

### Compose

```yaml
    environment:
      - N8N_HOST=${SUBDOMAIN}.${DOMAIN_NAME}
      - N8N_PORT=5678                                    # interner Listen-Port
      - N8N_PROTOCOL=https
      - N8N_EDITOR_BASE_URL=https://${SUBDOMAIN}.${DOMAIN_NAME}
      - N8N_WEBHOOK_URL=https://${SUBDOMAIN}.${DOMAIN_NAME}/
      - N8N_PROXY_HOPS=1
```

Env-Var-Namen geprüft gegen Tag `n8n@2.31.6`, `packages/@n8n/config/src/index.ts`:

```ts
@Env('N8N_EDITOR_BASE_URL')  editorBaseUrl: string = '';
@Env('N8N_WEBHOOK_URL')      webhookUrl: string = '';   // Nachfolger von WEBHOOK_URL
@Env('N8N_PROXY_HOPS')       proxy_hops: number = 0;
```

### Fallstricke

- **Die `.env` neben der `docker-compose.yml` landet nicht im Container.** Sie ist
  nur für Variablen-Interpolation im Compose-File. In den Container kommt
  ausschließlich, was unter `environment:` oder `env_file:` steht.
- **`docker compose restart` liest die Env nicht neu ein.** Es muss
  `docker compose up -d` sein.
- `WEBHOOK_TUNNEL_URL` (nur für `n8n start --tunnel`) und `VUE_APP_URL_BASE_API`
  (altes Frontend-Build-Var) tun hier nichts.

### Prüfen

```bash
docker exec <n8n-container> env | grep -E 'N8N_EDITOR_BASE_URL|N8N_WEBHOOK_URL|N8N_PROXY_HOPS'
```

## 2. NPMplus als Reverse Proxy

Der MCP-Endpunkt spricht Streamable HTTP: lange Verbindungen, Antwort als
`text/event-stream`. Das überlebt keine Default-Proxy-Konfiguration.

**Proxy Host → Details:**

| Einstellung | Wert |
|---|---|
| Scheme / Forward | `http` → Container-Name, Port `5678` |
| Disable Response Buffering | **an** — sonst kommt beim Client nichts an |
| Block Common Exploits | aus (JSON-RPC-Bodies laufen da rein) |
| Websockets | von NPMplus immer aktiv, nichts zu tun |

**Access List: `Publicly Accessible` lassen.** Basic Auth am Proxy setzt einen
eigenen `Authorization`-Header und überschreibt damit das MCP-Token. Die
Authentifizierung macht n8n selbst.

**Advanced-Tab leer lassen.** NPMplus setzt das meiste schon richtig und rät
ausdrücklich von Custom-Snippets ab. Falls Verbindungen nach ~60 s abreißen, ist
das die einzige sinnvolle Ergänzung:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Das greift, weil NPMplus den Advanced-Block auf Server-Ebene einfügt und diese
Direktiven in den `location`-Block vererbt werden. `proxy_set_header` dort **wirkt
nicht** — sobald ein `location`-Block eigene `proxy_set_header` hat, werden alle
geerbten verworfen. Deshalb bringen die üblichen SSE-Snippets aus dem Netz
(`proxy_set_header Connection '';`) in NPMplus nichts.

Wenn alles läuft: Port 5678 nach außen dichtmachen (Port-Mapping entfernen oder
auf `127.0.0.1:5678:5678` binden).

## 3. MCP-Server

Aktivieren unter *Settings → Instance-level MCP*. Endpunkt:
`https://n8n.joschka.eu/mcp-server/http`

### Discovery prüfen

```bash
curl -s https://n8n.joschka.eu/.well-known/oauth-authorization-server | jq -r '.issuer, .registration_endpoint'
curl -s https://n8n.joschka.eu/.well-known/oauth-protected-resource/mcp-server/http | jq -r '.resource'
```

Nirgends darf `:5678` auftauchen. Tut es das, zurück zu Abschnitt 1.

### Als Connector in claude.ai

Claude verbindet sich per **Dynamic Client Registration** — es registriert sich
selbst am `registration_endpoint`, bevor der Login überhaupt startet. Ein
statisches Bearer-Token akzeptiert der Connector-Dialog nicht.

Auf dem Consent-Screen von n8n ist der **Allow-Button ausgegraut**, bis die
Checkbox „I recognize and trust this URL" gesetzt ist. Das ist Absicht: Der
Client hat seine Callback-URL selbst mitgebracht, deshalb muss
`https://claude.ai/api/mcp/auth_callback` einmal per Hand bestätigt werden.

Nach einem gescheiterten Versuch bleiben Leichen zurück. Vor dem nächsten Anlauf:
Connector in claude.ai löschen **und** die halb registrierten Claude-Clients in
n8n wegräumen.

### Troubleshooting

| Symptom | Ursache |
|---|---|
| Verbindung steht, keine Daten, dann Timeout | Response Buffering nicht deaktiviert |
| Bricht reproduzierbar nach ~60 s ab | `proxy_read_timeout` zu kurz |
| „Registrierung beim Anmeldedienst fehlgeschlagen" | Metadaten zeigen auf falschen Host/Port (Abschnitt 1) |
| „A server with this URL already exists" | Alte Connector-Leiche in claude.ai |
| Allow-Button ausgegraut | Checkbox im gelben Kasten nicht gesetzt |
| `401` | Access List am Proxy setzt eigenen `Authorization`-Header |
| `403` schon beim Handshake | Block Common Exploits oder CrowdSec |
| `502` | Forward Hostname/Port falsch oder n8n nicht im selben Docker-Netz |

Wenn ein Request von Claude blockiert wird, lässt sich das isolieren, indem man
denselben Request einmal mit Default-UA und einmal mit `python-httpx/0.27.0`
schickt — unterschiedliche Statuscodes heißen: der Proxy filtert.

## 4. Claude-Code-Umgebung

Zwei getrennte Dinge, die gern verwechselt werden:

- **MCP-Connector** — Traffic läuft über Anthropics Server zur Instanz. Braucht
  **keinen** Eintrag in der Allowed-Domains-Liste, aber einen von außen
  erreichbaren Endpunkt.
- **Direkter Netzwerkzugriff** aus der Sandbox (z. B. `curl`) — dafür muss die
  Domain im Environment unter *Network access → Custom → Allowed domains*
  stehen. Dabei „Also include default list of common package managers"
  anhaken, sonst fallen GitHub und npm weg.

Änderungen am Environment greifen erst in einer **neuen** Session.

---

**Verifikationsstand:** Env-Var-Namen und die URL-Ableitung sind gegen den n8n-Quellcode
in Tag `n8n@2.31.6` geprüft. Die NPMplus-Angaben stammen aus Doku und
Issue-Threads — die Bezeichnungen der Toggles unterscheiden sich je nach Release.
