# Mealie Einkaufsliste (iOS Freitext) — n8n Workflow

Nimmt beliebigen Freitext entgegen (z. B. per Diktat aus iOS Shortcuts), extrahiert
per KI die einzelnen Artikel, ordnet sie den **vorhandenen** Mealie-Kategorien
(Labels) zu und schreibt sie in eine Mealie-Einkaufsliste.

In der Instanz angelegt als
[`cwIMVlzNkPwHtX9E`](https://n8n.joschka.eu/workflow/cwIMVlzNkPwHtX9E).
[`mealie-einkaufsliste.json`](./mealie-einkaufsliste.json) ist der Export dieses
Stands und lässt sich über *Workflows → … → Import from File* einspielen.

## Ablauf

| # | Node | Was passiert |
|---|------|--------------|
| 1 | `Einkaufszettel empfangen` | Webhook (POST), nimmt den Freitext entgegen |
| 2 | `Konfiguration` | Mealie-URL, Ziel-Listenname, Text normalisieren |
| 3 | `Mealie-Kategorien holen` | `GET /api/groups/labels?perPage=-1` |
| 4 | `Einkaufslisten holen` | `GET /api/households/shopping/lists?perPage=-1` |
| 5 | `Artikel & Kategorien erkennen` | Information Extractor: Extraktion **und** Kategoriezuordnung in einem LLM-Call, begrenzt auf die vorhandenen Labels |
| 6 | `Mealie-Payload bauen` | Label-Namen → Label-IDs, Ziel-Liste auflösen, Payload bauen |
| 7 | `Items an Mealie senden` | `POST /api/households/shopping/items/create-bulk` |
| 8 | `Antwort an iOS` | JSON-Zusammenfassung zurück an den Shortcut |

Schritt 2 und 4 der ursprünglichen Anforderung (Items auslesen / Kategorien
zuordnen) sind bewusst **ein** LLM-Call: das Modell sieht den Text und die
erlaubten Kategorien gleichzeitig, was die Zuordnung deutlich treffsicherer
macht als zwei getrennte Aufrufe — und kostet nur einen Request.

## Einrichtung

1. **Mealie-Token**: Mealie → Profil → *API Tokens* → Token erzeugen.
2. In n8n eine **Bearer Auth**-Credential („Mealie API Token") mit diesem Token
   anlegen und an allen drei `HTTP Request`-Nodes auswählen. Mealie
   authentifiziert mit `Authorization: Bearer <token>` — deshalb Bearer Auth und
   nicht Header Auth.
3. **Header Auth**-Credential für den Webhook (z. B. `X-Api-Key` / ein selbst
   gewähltes Geheimnis) am Node `Einkaufszettel empfangen` auswählen.
4. **Anthropic-Credential** am `Anthropic Chat Model` auswählen. Das Modell steht
   auf `claude-sonnet-4-6`; falls das in deinem Account nicht verfügbar ist, im
   Dropdown ein vorhandenes wählen. Der Node ist gegen jedes andere
   Chat-Model-Node austauschbar (OpenAI, Ollama, …) — der Information Extractor
   erwartet nur *irgendein* Sprachmodell am `ai_languageModel`-Eingang.
5. Im Node `Konfiguration` setzen:
   - `mealieUrl` → z. B. `https://mealie.joschka.eu` (ohne Slash am Ende)
   - `shoppingListName` → exakter Name der Liste in Mealie
     (kein Treffer → es wird die erste Liste genommen)
6. Workflow aktivieren.

## iOS Shortcut

Zwei Aktionen genügen:

1. *Text diktieren* (oder *Text eingeben*)
2. *Inhalte von URL abrufen*
   - URL: die Production-URL aus dem Webhook-Node
   - Methode: `POST`
   - Header: dein Webhook-Auth-Header
   - Anfragetext: `JSON` → Feld `text` = Ergebnis aus Schritt 1

Die genaue Production-URL steht im Webhook-Node; n8n hängt je nach Konfiguration
die Webhook-ID vor den Pfad. Nicht raten, sondern dort abschreiben.

Beispiel-Eingabe:

> „2 Liter Milch, Brot, ein Kilo Äpfel und noch Spülmittel"

Antwort:

```json
{
  "ok": true,
  "list": "Einkaufsliste",
  "added": 4,
  "categorized": 3,
  "unmatchedCategories": [],
  "items": ["Liter Milch", "Brot", "Kilo Äpfel", "Spülmittel"]
}
```

## Kategorien

Der KI werden ausschließlich die in Mealie **vorhandenen** Labels übergeben,
mit der expliziten Regel, keine neuen zu erfinden. Passt keine Kategorie,
bleibt `labelId` leer — das Item landet unkategorisiert in der Liste und der
Kategoriename taucht in der Antwort unter `unmatchedCategories` auf. Der
`Code`-Node matcht zusätzlich nur gegen real existierende Label-IDs, ein
halluzinierter Kategoriename kann also nichts kaputt machen.

## Instanz-Setup

Reverse Proxy, öffentliche Basis-URL und MCP-Server sind in
[docs/selfhosted-n8n-mcp.md](../docs/selfhosted-n8n-mcp.md) beschrieben. Relevant
hier vor allem, weil die Webhook-URL für den Shortcut von `N8N_EDITOR_BASE_URL` /
`N8N_WEBHOOK_URL` abhängt — ist die falsch gesetzt, zeigt n8n eine URL mit
`:5678` an, die hinter dem Proxy nicht funktioniert.

## Mealie-Versionen

Die Pfade gelten für **Mealie v2+**. Unter **v1** heißt der Namespace
`groups` statt `households`:

- v1: `POST /api/groups/shopping/items/create-bulk`
- v1: `GET  /api/groups/shopping/lists`

`GET /api/groups/labels` ist in beiden Versionen gleich.

## Abweichung zur Instanz

Im Node `Konfiguration` steht `mealieUrl` in dieser Datei auf
`https://mealie.example.com`. In der Instanz ist es ein n8n-Platzhalterwert, der
sich nicht sinnvoll exportieren lässt. Sonst ist die Datei ein 1:1-Abbild.
