# Mealie Einkaufsliste (iOS Freitext) — n8n Workflow

Nimmt beliebigen Freitext entgegen (z. B. per Diktat aus iOS Shortcuts), extrahiert
per KI die einzelnen Artikel, ordnet sie den **vorhandenen** Mealie-Kategorien
(Labels) zu und schreibt sie in eine Mealie-Einkaufsliste.

Datei: [`mealie-einkaufsliste.json`](./mealie-einkaufsliste.json) — in n8n über
*Workflows → … → Import from File* importieren.

## Ablauf

| # | Node | Was passiert |
|---|------|--------------|
| 1 | `Webhook (iOS)` | POST-Endpunkt, nimmt den Freitext entgegen |
| 2 | `Konfiguration` | Mealie-URL, Ziel-Listenname, Text normalisieren |
| 3 | `Kategorien holen` | `GET /api/groups/labels?perPage=-1` |
| 4 | `Einkaufslisten holen` | `GET /api/households/shopping/lists?perPage=-1` |
| 5 | `Items & Kategorien per KI` | Extraktion **und** Kategoriezuordnung in einem LLM-Call, begrenzt auf die vorhandenen Labels |
| 6 | `Mealie-Payload bauen` | Label-Namen → Label-IDs, Ziel-Liste auflösen, Payload bauen |
| 7 | `Items an Mealie senden` | `POST /api/households/shopping/items/create-bulk` |
| 8 | `Antwort an iOS` | JSON-Zusammenfassung zurück an den Shortcut |

Schritt 2 und 4 der ursprünglichen Anforderung (Items auslesen / Kategorien
zuordnen) sind bewusst **ein** LLM-Call: das Modell sieht den Text und die
erlaubten Kategorien gleichzeitig, was die Zuordnung deutlich treffsicherer
macht als zwei getrennte Aufrufe — und kostet nur einen Request.

## Einrichtung

1. **Mealie-Token**: Mealie → Profil → *API Tokens* → Token erzeugen.
2. In n8n eine **Header Auth**-Credential anlegen:
   `Name = Authorization`, `Value = Bearer <TOKEN>` und an beiden
   `HTTP Request`-Nodes sowie am `Items an Mealie senden`-Node auswählen.
3. Zweite **Header Auth**-Credential für den Webhook (z. B. `X-Api-Key` /
   ein selbst gewähltes Geheimnis) am `Webhook (iOS)`-Node auswählen.
4. OpenAI-Credential am `OpenAI Chat Model` auswählen (oder den Node durch
   einen beliebigen anderen Chat-Model-Node ersetzen — Anthropic, Ollama, …).
5. Im Node `Konfiguration` setzen:
   - `mealieUrl` → z. B. `https://mealie.joschka.eu` (ohne Slash am Ende)
   - `shoppingListName` → exakter Name der Liste in Mealie
     (kein Treffer → es wird die erste Liste genommen)

## iOS Shortcut

Zwei Aktionen genügen:

1. *Text diktieren* (oder *Text eingeben*)
2. *Inhalte von URL abrufen*
   - URL: `https://n8n.joschka.eu:5678/webhook/mealie-einkaufsliste`
   - Methode: `POST`
   - Header: dein Webhook-Auth-Header
   - Anfragetext: `JSON` → Feld `text` = Ergebnis aus Schritt 1

Beispiel-Eingabe:

> „2 Liter Milch, Brot, ein Kilo Äpfel und noch Spülmittel“

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

## Mealie-Versionen

Die Pfade gelten für **Mealie v2+**. Unter **v1** heißt der Namespace
`groups` statt `households`:

- v1: `POST /api/groups/shopping/items/create-bulk`
- v1: `GET  /api/groups/shopping/lists`

`GET /api/groups/labels` ist in beiden Versionen gleich.
