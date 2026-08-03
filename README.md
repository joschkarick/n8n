# n8n

Quellcode der n8n-Workflows auf `https://n8n.joschka.eu`, geschrieben mit dem
[n8n Workflow SDK](https://docs.n8n.io/).

## Workflows

| Datei | Workflow in n8n | Zweck |
| --- | --- | --- |
| [`workflows/mealie-essensplaner-ios-shortcut.ts`](workflows/mealie-essensplaner-ios-shortcut.ts) | Mealie Essensplaner (iOS Shortcut) | Plant per Zuruf ein vorhandenes Mealie-Rezept auf einen Tag im Essensplaner ein |
| – | Mealie Einkaufsliste (iOS Freitext) | Schreibt diktierte Artikel in eine Mealie-Einkaufsliste |
| [`workflows/bibliothek-verlaengerung.ts`](workflows/bibliothek-verlaengerung.ts) | Bibliothek Braunschweig – Verlängerung | Verlängert fällige Ausleihen im webOPAC automatisch und meldet das Ergebnis per ntfy |

> Der Einkaufslisten-Workflow existiert bisher nur in n8n und ist hier nicht als
> Quellcode hinterlegt; unten ist lediglich seine Sprachantwort dokumentiert.

## Weitere Komponenten

| Verzeichnis | Zweck |
| --- | --- |
| [`mealie-mcp/`](mealie-mcp/) | Macht den Mealie-MCP-Server für Claude im Web und auf dem iPhone erreichbar – HTTP-Vorbau plus OAuth gegen Authentik. Einrichtung: [ANLEITUNG.md](mealie-mcp/ANLEITUNG.md) |

## Gesprochene Antworten

Beide Mealie-Workflows liefern im Feld `message` einen fertigen Satz, den ein iOS
Shortcut direkt vorlesen lassen kann. Formuliert wird er von **Claude Haiku 4.5**
(Node *Antworttext formulieren* bzw. *Bestätigung formulieren*).

Die Aufteilung ist bewusst: Alle Fakten – Datum, Rezeptzuordnung, Anzahl – entstehen
deterministisch im Code-Node. Das Modell bekommt sie fertig geliefert und macht nur
noch die Sprache, also Satzbau sowie Einzahl und Mehrzahl. Es rechnet keine Daten aus
und wählt keine Rezepte.

Fällt die Formulierung aus, greift ein nüchterner Fallback-Satz aus dem Code-Node.

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
  "message": "Wraps sind für morgen eingeplant.",
  "recipe": "Wraps",
  "date": "2026-07-28",
  "day": "Dienstag, 28.07.2026",
  "dayPhrase": "morgen",
  "meal": "Abendessen",
  "matchType": "exakt",
  "entryId": 42
}
```

Rückfrage:

```json
{
  "ok": false,
  "message": "Ich habe kein Rezept namens Auflauf gefunden. Meintest du Kartoffelauflauf oder Nudelauflauf?",
  "requested": "Auflauf",
  "suggestions": ["Kartoffelauflauf", "Nudelauflauf"],
  "problems": ["Kein Tag erkannt", "Kein passendes Rezept gefunden"]
}
```

### Tagesangabe im Satz

`dayPhrase` entsteht im Code-Node und wird vom Modell wortwörtlich übernommen:

| Abstand | Formulierung |
| --- | --- |
| heute / morgen / übermorgen | `heute`, `morgen`, `übermorgen` |
| noch diese Woche | `Donnerstag` |
| nächste Woche | `Montag nächste Woche` |
| weiter weg | `Samstag, den 15.08.` |

Getestet: *„Wraps sind für morgen eingeplant."*, *„Lasagne ist für Samstag, den 15.08. eingeplant."*

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

---

## Mealie Einkaufsliste (iOS Freitext)

Nur die Sprachantwort ist hier dokumentiert, der Workflow selbst liegt in n8n.

Nach dem Schreiben der Artikel formuliert *Bestätigung formulieren* (Claude Haiku 4.5)
einen Satz mit **ausschliesslich der Anzahl** – nie mit einzelnen Artikeln:

```json
{
  "ok": true,
  "message": "Drei Artikel stehen auf der Einkaufsliste.",
  "list": "Montagseinkauf",
  "added": 3,
  "categorized": 3,
  "unmatchedCategories": [],
  "corrections": [{ "from": "Zwiebeln", "to": "Zwiebel" }],
  "items": ["Milch", "g Mehl", "Zwiebel"]
}
```

Die Detailfelder bleiben unverändert erhalten, falls der Shortcut mehr auswerten soll.
Für Siri reicht `message`.

---

## Bibliothek Braunschweig – Verlängerung

Prüft jeden Morgen das Konto im webOPAC der Stadtbibliothek Braunschweig,
verlängert alle fälligen Medien und schickt eine ntfy-Push aufs Handy.

Workflow in n8n: [`leF0zcLXUbC7GiGJ`](https://n8n.joschka.eu/workflow/leF0zcLXUbC7GiGJ)

### Ablauf

1. **Täglich prüfen** – Schedule Trigger, 08:00 Europe/Berlin
2. **Konfiguration** – `opacUrl`, `timezone`, `warnDays`, `ntfyServer`, `ntfyTopic`
3. **Sitzung starten** – `GET /start.do`, liefert `JSESSIONID` und `CSId`
4. **Sitzungsdaten** – Cookies und `CSId` aus dem HTML ziehen
5. **Anmelden** – `POST /login.do` mit `methodToCall=submit`, `CSId`, `username`, `password`
6. **Anmeldung prüfen** – Erfolg feststellen, Cookies fortschreiben
7. **Hinweisseite?** – falls der OPAC eine Zwischenseite zeigt: `login.do?methodToCall=done`
8. **Ausleihen holen** – `GET /userAccount.do?methodToCall=showAccount&typ=1`
9. **Ausleihen auswerten** – Tabelle parsen: Titel, Leihfristende, verlängerbar
10. **Verlängern nötig?** – nur wenn ein Medium in ≤ `warnDays` Tagen fällig ist
    - ja → **Alles verlängern** (`methodToCall=renewalPossible&renewal=account`)
      → **Ausleihen erneut holen** → **Verlängerung auswerten**
    - nein → direkt weiter, ohne Benachrichtigung
11. **Meldung bauen** → **Benachrichtigen?** → **Push senden** (ntfy)
12. **Abmelden** – `login.do?methodToCall=logout`

### Warum kein Browser

Der webOPAC ist OCLC **SISIS-SunRise** – ein klassisches Struts-Backend mit
`.do`-Endpunkten. Login und Verlängerung sind einfache Formular-Requests ohne
CAPTCHA und ohne JavaScript-Zwang. Playwright wäre unnötiger Ballast; der Flow
kommt mit HTTP-Request-Nodes aus und ist dadurch schnell und wartungsarm.

Das Protokoll ist gegengeprüft am Open-Source-Adapter der
[Web Opac App](https://github.com/opacapp/opacclient) (`SISIS.java`), der
dieselbe Software spricht.

### Zugangsdaten

Benutzernummer und Passwort stehen **nicht** im Workflow, sondern im Credential
**„OPAC Braunschweig"** vom Typ *Custom Auth*:

```json
{ "body": { "username": "DEINE-BENUTZERNUMMER", "password": "DEIN-PASSWORT" } }
```

n8n hängt diese Felder an den Formular-Body des Login-Requests an. Das Passwort
ist beim OPAC standardmäßig das Geburtsdatum im Format `TTMMJJ`.

### Wann verlängert wird

`warnDays` (Standard: 3) steuert, ab wann verlängert wird. Geprüft wird täglich,
gedrückt wird erst, wenn ein Medium innerhalb der nächsten drei Tage fällig ist.
Das verhindert, dass Leihtage verschenkt werden, falls die Bibliothek die neue
Frist ab dem Verlängerungstag statt ab dem alten Fristende rechnet.

### Benachrichtigung

Push über die eigene ntfy-Instanz `https://ntfy.joschka.eu`, Topic `bibliothek`.
In der ntfy-App dasselbe Topic auf dieser Instanz abonnieren.

Die Instanz läuft mit `auth-default-access: deny-all`. Der Node *Push senden*
meldet sich deshalb als ntfy-User `n8n` mit einem Token an – Credential
**„ntfy joschka.eu"** vom Typ *Bearer Auth*, Inhalt ist das Token `tk_…`.
ntfy akzeptiert es als `Authorization: Bearer tk_…`.

Der ntfy-User braucht außerdem Schreibrecht auf das Topic:

```
ntfy access n8n bibliothek write
```

Fehlt die ACL, antwortet ntfy trotz gültigem Token mit **403** – das ist der
übliche Stolperstein nach der Umstellung auf `deny-all`.

Es wird nur gemeldet, wenn es etwas zu sagen gibt:

| Lage | Titel | Priorität |
| --- | --- | --- |
| Verlängert | `3 Medien verlängert` | 3 |
| Teilweise verlängert | `Teilweise verlängert` | 5 |
| Nichts verlängerbar | `Verlängerung nicht möglich` | 5 |
| Anmeldung scheitert | `Bibliothek: Anmeldung fehlgeschlagen` | 5 |
| Kontoseite unlesbar | `Bibliothek: Konto nicht lesbar` | 4 |
| Nichts fällig | – (keine Push) | – |

Beispiel:

```
Teilweise verlängert

Neue Leihfrist: 30.08.2026
• Der Schwarm → 30.08.2026
• Die Känguru-Chroniken → 30.08.2026

Nicht verlängert — bitte zurückbringen:
• Sapiens (bis 05.08.2026) — vorgemerkt
```

Auf Pushover umstellen: im Node *Push senden* die URL auf
`https://api.pushover.net/1/messages.json` ändern und im Node *Meldung bauen*
`payload` auf `{ token, user, title, message, priority }` anpassen.

### Ob verlängert wurde, wird nachgeprüft

Der Flow verlässt sich nicht auf die Statusmeldungen der Verlängerungsseite –
deren Formulierungen unterscheiden sich je nach Installation. Stattdessen lädt
er die Kontoseite danach erneut und vergleicht die Leihfristen vorher/nachher.
Ein Titel gilt als verlängert, wenn sein Fristende sich geändert hat. Die
Statustexte der Verlängerungsseite werden nur als Begründung ergänzt
(z. B. *„vorgemerkt"*).
