import { workflow, node, trigger, sticky, ifElse, languageModel, expr } from '@n8n/workflow-sdk';

const receiveRequest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Rezeptwunsch empfangen',
    parameters: {
      httpMethod: 'POST',
      path: 'mealie-essensplan',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: {},
    },
    credentials: { httpHeaderAuth: { id: '4GhItMtMc1FNgTPA', name: 'Header Auth account' } },
    position: [-880, 300],
  },
  output: [{ body: { text: 'Plane Lasagne fuer Donnerstag zum Abendessen' } }],
});

const configuration = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Konfiguration',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          { id: 'mealie-url', name: 'mealieUrl', value: 'https://mealie.joschka.eu', type: 'string' },
          { id: 'timezone', name: 'timezone', value: 'Europe/Berlin', type: 'string' },
          { id: 'default-type', name: 'defaultEntryType', value: 'dinner', type: 'string' },
          {
            id: 'raw-text',
            name: 'text',
            value: expr("{{ typeof $json.body === 'string' ? $json.body : ($json.body?.text ?? $json.body?.Text ?? $json.body?.input ?? $json.text ?? '') }}"),
            type: 'string',
          },
        ],
      },
      options: {},
    },
    position: [-660, 300],
  },
  output: [{ mealieUrl: 'https://mealie.joschka.eu', timezone: 'Europe/Berlin', defaultEntryType: 'dinner', text: 'Plane Lasagne fuer Donnerstag zum Abendessen' }],
});

const fetchRecipes = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Rezepte holen',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.mealieUrl }}/api/recipes?perPage=-1&orderBy=name'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      options: {},
    },
    credentials: { httpBearerAuth: { id: 'ViMrCHhrvZvE71PG', name: 'Bearer Auth account' } },
    position: [-440, 300],
    executeOnce: true,
  },
  output: [{ items: [{ id: '5f3b2c1a-0000-4a2b-9c3d-1e2f3a4b5c6d', name: 'Lasagne', slug: 'lasagne' }] }],
});

const anthropicModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  version: 1.5,
  config: {
    name: 'Anthropic Chat Model',
    parameters: {
      model: { __rl: true, mode: 'list', value: 'claude-sonnet-4-6', cachedResultName: 'Claude Sonnet 4.6' },
      options: { temperature: 0 },
    },
    credentials: { anthropicApi: { id: 'GFkAkW87a3runrnv', name: 'Anthropic account' } },
    position: [-260, 560],
  },
});

const extractWish = node({
  type: '@n8n/n8n-nodes-langchain.informationExtractor',
  version: 1.2,
  config: {
    name: 'Rezept & Tag erkennen',
    parameters: {
      text: expr("{{ $('Konfiguration').item.json.text }}"),
      schemaType: 'manual',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: {
          recipeName: { type: 'string', description: 'Name des Rezepts. Wenn er eindeutig einem Rezept aus der vorgegebenen Liste entspricht, exakt diese Schreibweise uebernehmen. Sonst der Name so, wie er im Text steht.' },
          fromList: { type: 'boolean', description: 'true nur dann, wenn recipeName Zeichen fuer Zeichen aus der vorgegebenen Rezeptliste stammt' },
          dayReference: { type: 'string', description: 'Genau einer dieser Werte: heute, morgen, uebermorgen, wochentag, datum, keine' },
          weekday: { type: 'number', description: 'Wochentag als Zahl, Montag=1 bis Sonntag=7. 0 wenn kein Wochentag genannt wird' },
          nextWeek: { type: 'boolean', description: 'true nur, wenn ausdruecklich die naechste Woche gemeint ist, etwa bei naechsten Montag oder Montag naechster Woche' },
          date: { type: 'string', description: 'Konkretes Datum im Format YYYY-MM-DD, wenn im Text ein Datum steht. Sonst ein leerer String' },
          entryType: { type: 'string', description: 'Genau einer dieser Werte: breakfast, lunch, dinner, side, snack. Ohne Angabe im Text dinner' },
        },
        required: ['recipeName', 'fromList', 'dayReference', 'weekday', 'nextWeek', 'date', 'entryType'],
      }),
      options: {
        systemPromptTemplate: expr(
          'Du ordnest einen gesprochenen oder getippten Wunsch einem Rezept und einem Tag im Essensplaner zu.\n' +
          '\n' +
          'Heute ist {{ $now.setZone("Europe/Berlin").toFormat("cccc") }}, der {{ $now.setZone("Europe/Berlin").toFormat("yyyy-MM-dd") }}.\n' +
          '\n' +
          'Verfuegbare Rezepte in Mealie:\n' +
          "{{ $('Rezepte holen').item.json.items.map(r => '- ' + r.name).join('\\n') }}\n" +
          '\n' +
          'Regeln:\n' +
          '1. recipeName ist der Name des gewuenschten Rezepts. Entspricht der genannte Name eindeutig einem Rezept aus der Liste oben, uebernimm genau dessen Schreibweise Zeichen fuer Zeichen und setze fromList auf true.\n' +
          '2. Diktier- und Tippfehler darfst du dabei ausgleichen, aber nur bei Eindeutigkeit. Bist du dir nicht sicher, welches Rezept gemeint ist, gib den Namen aus dem Text unveraendert zurueck und setze fromList auf false.\n' +
          '3. Niemals auf ein Rezept korrigieren, das etwas anderes bezeichnet. Nudelauflauf und Kartoffelauflauf sind verschiedene Rezepte, ebenso Tomatensuppe und Tomatensosse.\n' +
          '4. Steht das Rezept nicht in der Liste, gib den Namen aus dem Text zurueck und setze fromList auf false. Erfinde niemals einen Rezeptnamen.\n' +
          '5. dayReference beschreibt, wie der Tag genannt wurde: heute, morgen, uebermorgen, wochentag bei einem Wochentagsnamen, datum bei einem konkreten Datum, keine wenn kein Tag genannt wird.\n' +
          '6. weekday ist der genannte Wochentag als Zahl von 1 fuer Montag bis 7 fuer Sonntag, sonst 0.\n' +
          '7. nextWeek ist nur true, wenn ausdruecklich die naechste Woche gemeint ist.\n' +
          '8. date fuellst du nur bei einem konkreten Datum, im Format YYYY-MM-DD und ausgehend vom heutigen Datum oben. Sonst ein leerer String.\n' +
          '9. entryType ist die Mahlzeit: breakfast fuer Fruehstueck, lunch fuer Mittagessen, dinner fuer Abendessen, side fuer Beilage, snack fuer Snack. Ohne Angabe dinner.\n' +
          '10. Fuellwoerter wie plane bitte, ich moechte oder koch am ignorieren.'
        ),
      },
    },
    subnodes: { model: anthropicModel },
    position: [-200, 300],
  },
});

const resolveEntry = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Rezept & Datum aufloesen',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const cfg = $('Konfiguration').first().json;
const recipes = $('Rezepte holen').first().json.items || [];
const raw = $input.first().json;
const ai = raw && raw.output && typeof raw.output === 'object' ? raw.output : raw;

const DT = typeof DateTime !== 'undefined' ? DateTime : $now.constructor;

const norm = (s) =>
  (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const ALLOWED_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'snack'];
const TYPE_DE = { breakfast: 'Frühstück', lunch: 'Mittagessen', dinner: 'Abendessen', side: 'Beilage', snack: 'Snack' };
const WEEKDAY_DE = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

const problems = [];

// --- Tag bestimmen ---
const tz = cfg.timezone || 'Europe/Berlin';
const today = $now.setZone(tz).startOf('day');
const ref = norm(ai.dayReference);
const explicitDate = (ai.date ?? '').toString().trim();

let target = null;
if (/^\\d{4}-\\d{2}-\\d{2}$/.test(explicitDate)) {
  const parsed = DT.fromISO(explicitDate, { zone: tz }).startOf('day');
  if (parsed.isValid) target = parsed;
} else if (ref === 'heute') {
  target = today;
} else if (ref === 'morgen') {
  target = today.plus({ days: 1 });
} else if (ref === 'uebermorgen') {
  target = today.plus({ days: 2 });
}

if (!target) {
  const wd = Number(ai.weekday);
  if (Number.isInteger(wd) && wd >= 1 && wd <= 7) {
    // Naechstes Vorkommen des Wochentags, heute zaehlt mit.
    let delta = (wd - today.weekday + 7) % 7;
    if (ai.nextWeek === true) delta += 7;
    target = today.plus({ days: delta });
  }
}

if (!target) problems.push('Kein Tag erkannt');

// --- Rezept bestimmen ---
const byNorm = new Map();
for (const r of recipes) {
  const key = norm(r.name);
  if (key && !byNorm.has(key)) byNorm.set(key, r);
}

const wanted = norm(ai.recipeName);
let recipe = wanted ? byNorm.get(wanted) || null : null;
let matchType = recipe ? 'exakt' : '';
let suggestions = [];

if (!recipe && wanted) {
  const partial = recipes.filter((r) => {
    const n = norm(r.name);
    return n && (n.includes(wanted) || wanted.includes(n));
  });
  if (partial.length === 1) {
    recipe = partial[0];
    matchType = 'teiltreffer';
  } else if (partial.length > 1) {
    suggestions = partial.slice(0, 5).map((r) => r.name);
  }
}

if (!recipe && wanted && suggestions.length === 0) {
  const wTokens = wanted.split(' ').filter((t) => t.length > 2);
  const scored = recipes
    .map((r) => {
      const tokens = norm(r.name).split(' ').filter(Boolean);
      let score = 0;
      for (const t of wTokens) {
        if (tokens.some((x) => x.startsWith(t) || t.startsWith(x))) score += 1;
      }
      return { recipe: r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Nur uebernehmen, wenn der beste Treffer eindeutig besser ist als der zweitbeste.
  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    recipe = scored[0].recipe;
    matchType = 'aehnlich';
  } else if (scored.length > 1) {
    suggestions = scored.slice(0, 5).map((x) => x.recipe.name);
  }
}

if (!recipe) problems.push('Kein passendes Rezept gefunden');

// --- Mahlzeit bestimmen ---
let entryType = norm(ai.entryType).replace(/ /g, '');
if (!ALLOWED_TYPES.includes(entryType)) entryType = norm(cfg.defaultEntryType).replace(/ /g, '');
if (!ALLOWED_TYPES.includes(entryType)) entryType = 'dinner';

const ok = Boolean(recipe && target);
const dateIso = target ? target.toFormat('yyyy-MM-dd') : '';
const dayLabel = target ? WEEKDAY_DE[target.weekday] + ', ' + target.toFormat('dd.MM.yyyy') : '';

let message;
if (ok) {
  message = recipe.name + ' ist für ' + dayLabel + ' zum ' + TYPE_DE[entryType] + ' eingeplant.';
} else if (!recipe && suggestions.length > 0) {
  message = 'Kein eindeutiges Rezept für "' + (ai.recipeName ?? '') + '" gefunden. Meintest du: ' + suggestions.join(', ') + '?';
} else if (!recipe) {
  message = 'Kein Rezept für "' + (ai.recipeName ?? '') + '" in Mealie gefunden.';
} else {
  message = 'Es war nicht erkennbar, für welchen Tag geplant werden soll.';
}

return [
  {
    json: {
      ok,
      message,
      problems,
      requested: ai.recipeName ?? '',
      matchType,
      suggestions,
      recipe: recipe ? { id: recipe.id, name: recipe.name, slug: recipe.slug } : null,
      date: dateIso,
      dayLabel,
      entryType,
      entryTypeDe: TYPE_DE[entryType],
      recipeCount: recipes.length,
      payload: recipe && target ? { date: dateIso, entryType, title: '', text: '', recipeId: recipe.id } : null,
    },
  },
];`,
    },
    position: [60, 300],
  },
  output: [
    {
      ok: true,
      message: 'Lasagne ist für Donnerstag, 30.07.2026 zum Abendessen eingeplant.',
      problems: [],
      requested: 'Lasagne',
      matchType: 'exakt',
      suggestions: [],
      recipe: { id: '5f3b2c1a-0000-4a2b-9c3d-1e2f3a4b5c6d', name: 'Lasagne', slug: 'lasagne' },
      date: '2026-07-30',
      dayLabel: 'Donnerstag, 30.07.2026',
      entryType: 'dinner',
      entryTypeDe: 'Abendessen',
      recipeCount: 128,
      payload: { date: '2026-07-30', entryType: 'dinner', title: '', text: '', recipeId: '5f3b2c1a-0000-4a2b-9c3d-1e2f3a4b5c6d' },
    },
  ],
});

const isResolved = ifElse({
  version: 2.2,
  config: {
    name: 'Rezept und Tag klar?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          { leftValue: expr('{{ $json.ok }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } },
        ],
        combinator: 'and',
      },
      options: {},
    },
    position: [280, 300],
  },
});

const createMealPlanEntry = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Eintrag im Essensplaner anlegen',
    parameters: {
      method: 'POST',
      url: expr("{{ $('Konfiguration').item.json.mealieUrl }}/api/households/mealplans"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.payload) }}'),
      options: {},
    },
    credentials: { httpBearerAuth: { id: 'ViMrCHhrvZvE71PG', name: 'Bearer Auth account' } },
    position: [520, 180],
  },
  output: [{ id: 42, date: '2026-07-30', entryType: 'dinner', title: '', text: '', recipeId: '5f3b2c1a-0000-4a2b-9c3d-1e2f3a4b5c6d' }],
});

const respondSuccess = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Antwort an iOS',
    parameters: {
      respondWith: 'json',
      responseBody: expr("{{ JSON.stringify({ ok: true, message: $('Rezept & Datum aufloesen').first().json.message, recipe: $('Rezept & Datum aufloesen').first().json.recipe.name, date: $('Rezept & Datum aufloesen').first().json.date, day: $('Rezept & Datum aufloesen').first().json.dayLabel, meal: $('Rezept & Datum aufloesen').first().json.entryTypeDe, matchType: $('Rezept & Datum aufloesen').first().json.matchType, entryId: $json.id }) }}"),
      options: {},
    },
    position: [740, 180],
    executeOnce: true,
  },
  output: [{ ok: true, message: 'Lasagne ist für Donnerstag, 30.07.2026 zum Abendessen eingeplant.' }],
});

const respondUnresolved = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Rueckfrage an iOS',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: false, message: $json.message, requested: $json.requested, suggestions: $json.suggestions, problems: $json.problems }) }}'),
      options: {},
    },
    position: [520, 440],
    executeOnce: true,
  },
  output: [{ ok: false, message: 'Kein Rezept für "Lasagnee" in Mealie gefunden.' }],
});

const setupNote = sticky(
  '## Vor dem ersten Lauf\n\n' +
    '**Credentials sind bereits verdrahtet** – dieselben wie beim Einkaufslisten-Workflow:\n' +
    '- *Bearer Auth account* → Mealie API Token\n' +
    '- *Header Auth account* → Webhook-Auth für den iOS Shortcut\n' +
    '- *Anthropic account* → am Anthropic Chat Model\n\n' +
    '**Konfiguration anpassen:** mealieUrl, timezone und defaultEntryType (Mahlzeit, wenn im Text keine genannt wird).',
  [receiveRequest, configuration],
  { color: 4, width: 520, height: 220 }
);

const apiNote = sticky(
  '## Mealie-API\n\n' +
    'Pfade gelten für **Mealie v2+**:\n' +
    '- GET /api/recipes\n' +
    '- POST /api/households/mealplans\n\n' +
    'Body des Eintrags: date (YYYY-MM-DD), entryType, title, text, recipeId.\n\n' +
    'Unter **v1** heisst der Namespace groups statt households.',
  [fetchRecipes],
  { color: 5, width: 400, height: 220 }
);

const matchingNote = sticky(
  '## Nichts erfinden, nur zuordnen\n\n' +
    '**Rezept:** Die KI bekommt ausschliesslich die vorhandenen Mealie-Rezepte und darf keine neuen erfinden. Der Code-Node matcht anschliessend selbst gegen die echte Liste – exakt, dann als Teiltreffer, dann über Wortähnlichkeit. Ein Treffer wird nur übernommen, wenn er eindeutig ist; sonst kommen Vorschläge zurück statt eines falschen Eintrags.\n\n' +
    '**Tag:** Ein blosser Wochentag meint das nächste Vorkommen, wobei heute mitzählt. "nächsten Montag" springt eine Woche weiter. Ausserdem verstanden: heute, morgen, übermorgen und konkrete Daten.\n\n' +
    '**Mahlzeit:** breakfast, lunch, dinner, side, snack – ohne Angabe der Wert aus defaultEntryType.',
  [extractWish, resolveEntry],
  { color: 3, width: 600, height: 300 }
);

const responseNote = sticky(
  '## Antwort an den Shortcut\n\n' +
    'Beide Wege antworten mit HTTP 200 und einem Feld **ok**, damit der Shortcut nicht in einen Fehler läuft.\n\n' +
    '- ok = true: message vorlesen lassen\n' +
    '- ok = false: message enthält die Rückfrage, suggestions die passenden Rezeptnamen',
  [createMealPlanEntry, respondSuccess, respondUnresolved],
  { color: 6, width: 460, height: 240 }
);

export default workflow('mealie-essensplaner', 'Mealie Essensplaner (iOS Shortcut)')
  .add(receiveRequest)
  .to(configuration)
  .to(fetchRecipes)
  .to(extractWish)
  .to(resolveEntry)
  .to(
    isResolved
      .onTrue(createMealPlanEntry.to(respondSuccess))
      .onFalse(respondUnresolved)
  )
  .add(setupNote)
  .add(apiNote)
  .add(matchingNote)
  .add(responseNote);
