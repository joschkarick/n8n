# n8n

Quellcode der n8n-Workflows auf `https://n8n.joschka.eu`, geschrieben mit dem
[n8n Workflow SDK](https://docs.n8n.io/).

## Workflows

| Datei | Workflow in n8n | Zweck |
| --- | --- | --- |
| [`workflows/mealie-essensplaner-ios-shortcut.ts`](workflows/mealie-essensplaner-ios-shortcut.ts) | Mealie Essensplaner (iOS Shortcut) | Plant per Zuruf ein vorhandenes Mealie-Rezept auf einen Tag im Essensplaner ein |

---

## Mealie Essensplaner (iOS Shortcut)

Nimmt einen Freitext entgegen – etwa *„Plane Lasagne für Donnerstag zum Abendessen"* –
und legt daraus einen Eintrag im Mealie-Essensplaner an.

### Ablauf

1. **Rezeptwunsch empfangen** – Webhook (POST, Header-Auth)
2. **Konfiguration** – `mealieUrl`, `timezone`, `defaultEntryType`; normalisiert den Eingabetext
3. **Rezepte holen** – `GET /api/recipes?perPage=-1&orderBy=name`
4. **Rezept & Tag erkennen** – Information Extractor (Claude Sonnet 4.6) mit der echten Rezeptliste im Prompt
5. **Rezept & Datum auflösen** – Code-Node: Rezept-Matching gegen die echte Liste, Wochentag → Datum
6. **Rezept und Tag klar?** – IF
   - ja → **Eintrag im Essensplaner anlegen** (`POST /api/households/mealplans`) → **Antwort an iOS**
   - nein → **Rückfrage an iOS** mit Vorschlägen

### Aufruf

```
POST https://n8n.joschka.eu/webhook/<webhook-id>/mealie-essensplan
X-Api-Key: <Wert aus dem Credential "Header Auth account">
Content-Type: application/json

{ "text": "Plane Lasagne für Donnerstag zum Abendessen" }
```

Die konkrete Produktions-URL steht im Workflow am Node *Rezeptwunsch empfangen*.

### Antwort

Beide Pfade antworten mit HTTP 200, damit der Shortcut nicht in einen Fehler läuft.
Unterschieden wird über das Feld `ok`.

Erfolg:

```json
{
  "ok": true,
  "message": "Lasagne ist für Donnerstag, 30.07.2026 zum Abendessen eingeplant.",
  "recipe": "Lasagne",
  "date": "2026-07-30",
  "day": "Donnerstag, 30.07.2026",
  "meal": "Abendessen",
  "matchType": "exakt",
  "entryId": 42
}
```

Rückfrage:

```json
{
  "ok": false,
  "message": "Kein eindeutiges Rezept für \"Auflauf\" gefunden. Meintest du: Kartoffelauflauf, Nudelauflauf?",
  "requested": "Auflauf",
  "suggestions": ["Kartoffelauflauf", "Nudelauflauf"],
  "problems": ["Kein Tag erkannt", "Kein passendes Rezept gefunden"]
}
```

### iOS Shortcut

1. **Text diktieren** (oder *Eingabe anfordern*)
2. **Inhalte von URL abrufen**
   - Methode `POST`
   - Header `X-Api-Key` mit dem Wert aus dem Credential *Header Auth account*
   - Anfragetext `JSON`, Feld `text` = Ergebnis aus Schritt 1
3. **Wert abrufen** `message` aus dem Ergebnis
4. **Text vorlesen** (oder als Mitteilung anzeigen)

Wer die Rückfragen abfangen will, prüft vorher `ok` mit einem *Falls*-Block.

### Tag-Auflösung

- Ein blosser Wochentag meint das nächste Vorkommen, **heute zählt mit**
  („Montag" an einem Montag ist heute).
- „nächsten Montag" springt eine Woche weiter.
- Ausserdem verstanden: `heute`, `morgen`, `übermorgen` und konkrete Daten.
- Zeitzone kommt aus `timezone` im Node *Konfiguration*.

### Mahlzeiten

`breakfast`, `lunch`, `dinner`, `side`, `snack` – ohne Angabe im Text greift
`defaultEntryType` aus der Konfiguration (`dinner`).

### Rezept-Matching

Die KI darf ausschliesslich aus den vorhandenen Mealie-Rezepten wählen und keine
neuen erfinden. Der Code-Node matcht anschliessend selbst gegen die echte Liste:

1. exakter Treffer (normalisiert, inkl. Umlaut-Ersetzung)
2. Teiltreffer – nur wenn genau ein Rezept passt
3. Wortähnlichkeit – nur wenn der beste Treffer eindeutig besser ist als der zweitbeste

Bleibt es mehrdeutig, wird **kein** Eintrag angelegt; stattdessen kommen Vorschläge zurück.
