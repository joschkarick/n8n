import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

/**
 * Verlängert automatisch alle Ausleihen im webOPAC der Stadtbibliothek Braunschweig
 * (OCLC SISIS-SunRise) und meldet das Ergebnis per ntfy aufs Handy.
 *
 * Protokoll (reines HTTP, kein Browser nötig):
 *   GET  /start.do                                          -> JSESSIONID + CSId
 *   POST /login.do            methodToCall=submit, CSId, username, password
 *   GET  /userAccount.do?methodToCall=showAccount&typ=1      -> Ausleihen
 *   GET  /userAccount.do?methodToCall=renewalPossible&renewal=account  -> alles verlängern
 *
 * Zugangsdaten liegen im Credential "OPAC Braunschweig" (Custom Auth), nicht im Workflow.
 */

// Gemeinsamer HTML-Parser für die Ausleihtabelle. Wird in zwei Code-Nodes
// gebraucht (vor und nach dem Verlängern), daher hier einmal als String.
const PARSER = `
const ENTITIES = { nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
function decode(s) {
  return String(s)
    .replace(/&#(\\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}
function clean(s) {
  return decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\\s+/g, ' ').trim();
}
function parseLoans(html, zone) {
  const table = String(html).match(/<table[^>]*class="[^"]*\\bdata\\b[^"]*"[\\s\\S]*?<\\/table>/i);
  if (!table) return { found: false, items: [] };
  const rows = Array.from(table[0].matchAll(/<tr[\\s\\S]*?<\\/tr>/gi)).map(m => m[0]);
  const today = $now.setZone(zone).startOf('day');
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (/keine\\s+(Daten|Ausleihen)/i.test(clean(row))) continue;
    const cells = Array.from(row.matchAll(/<td[^>]*>[\\s\\S]*?<\\/td>/gi)).map(m => m[0]);
    if (cells.length < 2) continue;

    const strong = row.match(/<strong[^>]*>([\\s\\S]*?)<\\/strong>/i);
    const title = strong ? clean(strong[1]) : clean(cells[1] || cells[0]);
    const date = row.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})/);
    let deadline = null;
    let daysLeft = null;
    if (date) {
      const dt = DateTime.fromFormat(date[0], 'dd.MM.yyyy', { zone });
      if (dt.isValid) {
        deadline = date[0];
        daysLeft = Math.round(dt.startOf('day').diff(today, 'days').days);
      }
    }
    const hasLink = /methodToCall=renewalPossible/i.test(row);
    const hasBox = /<input[^>]*type="checkbox"(?![^>]*disabled)/i.test(row);
    const noteMatch = row.match(/class="[^"]*(?:textrot|textgruen|textdunkelblau)[^"]*"[^>]*>([\\s\\S]*?)<\\//i);
    items.push({
      title,
      deadline,
      daysLeft,
      renewable: hasLink || hasBox,
      note: noteMatch ? clean(noteMatch[1]) : null,
    });
  }
  return { found: true, items };
}
`;

const dailyCheck = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Täglich prüfen',
    parameters: {
      rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 8, triggerAtMinute: 0 }] },
    },
    position: [-1560, 0],
  },
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
          { id: 'opac-url', name: 'opacUrl', value: 'https://webopac.braunschweig.de/webOPACClient', type: 'string' },
          { id: 'timezone', name: 'timezone', value: 'Europe/Berlin', type: 'string' },
          { id: 'warn-days', name: 'warnDays', value: 3, type: 'number' },
          { id: 'ntfy-server', name: 'ntfyServer', value: 'https://ntfy.sh', type: 'string' },
          { id: 'ntfy-topic', name: 'ntfyTopic', value: 'HIER-EIGENES-TOPIC-EINTRAGEN', type: 'string' },
        ],
      },
      options: {},
    },
    position: [-1340, 0],
  },
});

const startSession = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Sitzung starten',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.opacUrl }}/start.do'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'User-Agent', value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36' },
        ],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 30000,
      },
    },
    position: [-1120, 0],
  },
});

const sessionData = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Sitzungsdaten',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Cookies und CSId aus der Startseite ziehen — beides braucht der Login.
const r = $input.first().json;
const raw = r.headers && r.headers['set-cookie'] ? r.headers['set-cookie'] : [];
const list = Array.isArray(raw) ? raw : [raw];
const cookie = list.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
const html = String(r.html || r.body || '');
const m = html.match(/name="CSId"[^>]*value="([^"]*)"/i);
return [{ json: { statusCode: r.statusCode, cookie, csid: m ? m[1] : '' } }];`,
    },
    position: [-900, 0],
  },
});

const logIn = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Anmelden',
    parameters: {
      method: 'POST',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/login.do'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Cookie', value: expr('{{ $json.cookie }}') },
          { name: 'User-Agent', value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36' },
        ],
      },
      sendBody: true,
      contentType: 'form-urlencoded',
      bodyParameters: {
        parameters: [
          { name: 'methodToCall', value: 'submit' },
          { name: 'CSId', value: expr('{{ $json.csid }}') },
        ],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 30000,
      },
    },
    credentials: { httpCustomAuth: newCredential('OPAC Braunschweig') },
    position: [-680, 0],
  },
});

const checkLogin = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Anmeldung prüfen',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Erfolg/Fehler der Anmeldung feststellen und die Session-Cookies fortschreiben.
const r = $input.first().json;
const before = $('Sitzungsdaten').first().json;
const html = String(r.html || r.body || '');

const raw = r.headers && r.headers['set-cookie'] ? r.headers['set-cookie'] : [];
const list = Array.isArray(raw) ? raw : [raw];
const jar = {};
for (const c of String(before.cookie || '').split('; ')) {
  if (c) jar[c.split('=')[0]] = c;
}
for (const c of list) {
  const pair = String(c).split(';')[0];
  if (pair) jar[pair.split('=')[0]] = pair;
}
const cookie = Object.values(jar).join('; ');

// Das Login-Formular erscheint erneut => Anmeldung hat nicht geklappt.
const stillLoginForm = /name="password"/i.test(html) && /LoginBean/i.test(html);
const errorBox = html.match(/class="error"[^>]*>([\\s\\S]*?)<\\//i);
const message = errorBox
  ? errorBox[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ').trim()
  : null;

// Manche Installationen schieben eine Hinweisseite dazwischen ("weiter"-Klick).
const needsDone = /methodToCall=done/i.test(html);
const loginOk = !stillLoginForm && !message;

return [{ json: {
  loginOk,
  needsDone: loginOk && needsDone,
  message,
  cookie,
  csid: (html.match(/name="CSId"[^>]*value="([^"]*)"/i) || [null, before.csid])[1],
  statusCode: r.statusCode,
} }];`,
    },
    position: [-460, 0],
  },
});

const noticePage = ifElse({
  version: 2.3,
  config: {
    name: 'Hinweisseite?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          { leftValue: expr('{{ $json.needsDone }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: '' },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
    },
    position: [-240, 0],
  },
});

const confirmNotice = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Hinweis bestätigen',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/login.do?methodToCall=done'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Cookie', value: expr('{{ $("Anmeldung prüfen").first().json.cookie }}') }],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 30000,
      },
    },
    position: [-20, -160],
  },
});

const fetchLoans = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Ausleihen holen',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/userAccount.do?methodToCall=showAccount&typ=1'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Cookie', value: expr('{{ $("Anmeldung prüfen").first().json.cookie }}') }],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 30000,
      },
    },
    position: [200, 0],
  },
});

const readLoans = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Ausleihen auswerten',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `${PARSER}
const cfg = $('Konfiguration').first().json;
const login = $('Anmeldung prüfen').first().json;
const html = String($input.first().json.html || $input.first().json.body || '');
const parsed = parseLoans(html, cfg.timezone);

const due = parsed.items.filter(i => i.daysLeft !== null && i.daysLeft <= cfg.warnDays);
const renewalNeeded = login.loginOk && due.length > 0 && due.some(i => i.renewable);

return [{ json: {
  loginOk: login.loginOk,
  loginMessage: login.message,
  tableFound: parsed.found,
  items: parsed.items,
  count: parsed.items.length,
  dueSoon: due,
  renewalNeeded,
  // Rohtext beim ersten echten Lauf zur Kontrolle des Parsings
  debugRows: parsed.items.length === 0 ? clean(html).slice(0, 1500) : null,
} }];`,
    },
    position: [420, 0],
  },
});

const renewalNeeded = ifElse({
  version: 2.3,
  config: {
    name: 'Verlängern nötig?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          { leftValue: expr('{{ $json.renewalNeeded }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: '' },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
    },
    position: [640, 0],
  },
});

const renewAll = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Alles verlängern',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/userAccount.do?methodToCall=renewalPossible&renewal=account'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Cookie', value: expr('{{ $("Anmeldung prüfen").first().json.cookie }}') }],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 60000,
      },
    },
    position: [860, -160],
  },
});

const refetchLoans = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Ausleihen erneut holen',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/userAccount.do?methodToCall=showAccount&typ=1'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Cookie', value: expr('{{ $("Anmeldung prüfen").first().json.cookie }}') }],
      },
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        timeout: 30000,
      },
    },
    position: [1080, -160],
  },
});

const readResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Verlängerung auswerten',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `${PARSER}
// Wahrheit ist die neu geladene Kontoseite: Was hat sich an den Fristen geändert?
const cfg = $('Konfiguration').first().json;
const before = $('Ausleihen auswerten').first().json;
const after = parseLoans(String($input.first().json.html || $input.first().json.body || ''), cfg.timezone);

const previous = new Map();
for (const i of before.items) previous.set(i.title, i.deadline);

const renewed = [];
const unchanged = [];
for (const item of after.items) {
  const old = previous.get(item.title);
  if (old && item.deadline && old !== item.deadline) {
    renewed.push({ title: item.title, from: old, to: item.deadline });
  } else if (item.daysLeft !== null && item.daysLeft <= cfg.warnDays) {
    unchanged.push(item);
  }
}

// Statusmeldungen der Verlängerungsseite als Zusatzinfo (Gründe wie "vorgemerkt").
const resultHtml = String($('Alles verlängern').first().json.html || '');
const reasons = {};
const cells = Array.from(resultHtml.matchAll(/<td[^>]*>[\\s\\S]*?<\\/td>/gi)).map(m => clean(m[0]));
for (const text of cells) {
  if (!/Titel\\s*:/.test(text) || !/Status\\s*:/.test(text)) continue;
  const re = /(Titel|Verfasser|Mediennummer|Signatur|Leihfristende|Status)\\s*:/g;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ label: m[1], end: re.lastIndex, start: m.index });
  const field = {};
  hits.forEach((h, i) => {
    field[h.label] = text.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : text.length).trim();
  });
  if (field.Titel && field.Status) reasons[field.Titel] = field.Status;
}

return [{ json: {
  renewedItems: renewed,
  stillDue: unchanged.map(i => ({ ...i, reason: reasons[i.title] || i.note || null })),
  attempted: before.dueSoon.length,
  totalAfter: after.items.length,
  itemsAfter: after.items,
} }];`,
    },
    position: [1300, -160],
  },
});

const buildMessage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Meldung bauen',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Ein einziger Ort, an dem entschieden wird: Wird gemeldet, und was steht drin?
const cfg = $('Konfiguration').first().json;
const loans = $('Ausleihen auswerten').first().json;

let result = null;
try { result = $('Verlängerung auswerten').first().json; } catch (e) { result = null; }

const lines = [];
let title = 'Bibliothek';
let priority = 3;
let tags = ['books'];
let notify = false;

if (!loans.loginOk) {
  title = 'Bibliothek: Anmeldung fehlgeschlagen';
  lines.push(loans.loginMessage || 'Benutzernummer oder Passwort wurden nicht akzeptiert.');
  lines.push('Bitte die Zugangsdaten im n8n-Credential "OPAC Braunschweig" prüfen.');
  priority = 5;
  tags = ['warning'];
  notify = true;
} else if (!loans.tableFound) {
  title = 'Bibliothek: Konto nicht lesbar';
  lines.push('Die Kontoseite sah anders aus als erwartet — es wurde nichts verlängert.');
  priority = 4;
  tags = ['warning'];
  notify = true;
} else if (result) {
  const renewed = result.renewedItems || [];
  const stillDue = result.stillDue || [];

  if (renewed.length > 0) {
    const newDates = Array.from(new Set(renewed.map(r => r.to)));
    title = renewed.length === 1 ? '1 Medium verlängert' : renewed.length + ' Medien verlängert';
    lines.push(newDates.length === 1
      ? 'Neue Leihfrist: ' + newDates[0]
      : 'Neue Leihfristen: ' + newDates.join(', '));
    for (const r of renewed) lines.push('• ' + r.title + ' → ' + r.to);
    tags = ['white_check_mark'];
    notify = true;
  }

  if (stillDue.length > 0) {
    title = renewed.length > 0 ? 'Teilweise verlängert' : 'Verlängerung nicht möglich';
    lines.push('');
    lines.push('Nicht verlängert — bitte zurückbringen:');
    for (const i of stillDue) {
      lines.push('• ' + i.title + ' (bis ' + (i.deadline || 'unbekannt') + ')' + (i.reason ? ' — ' + i.reason : ''));
    }
    priority = 5;
    tags = ['warning'];
    notify = true;
  }

  if (renewed.length === 0 && stillDue.length === 0) {
    title = 'Bibliothek: nichts verändert';
    lines.push('Die Verlängerung lief durch, die Fristen sind aber gleich geblieben.');
    priority = 4;
    tags = ['warning'];
    notify = true;
  }
} else {
  // Kein Verlängerungslauf: nichts war fällig.
  const next = loans.items
    .filter(i => i.daysLeft !== null)
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
  lines.push(loans.count + ' Medien entliehen.' + (next ? ' Nächste Frist: ' + next.deadline + '.' : ''));
  notify = false;
}

const message = lines.join('\\n').trim() || 'Keine Details.';

return [{ json: {
  notify,
  title,
  message,
  payload: {
    topic: cfg.ntfyTopic,
    title: title,
    message: message,
    priority: priority,
    tags: tags,
  },
} }];`,
    },
    position: [1520, 0],
  },
});

const shouldNotify = ifElse({
  version: 2.3,
  config: {
    name: 'Benachrichtigen?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          { leftValue: expr('{{ $json.notify }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: '' },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
    },
    position: [1740, 0],
  },
});

const sendPush = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Push senden',
    parameters: {
      method: 'POST',
      url: expr('{{ $("Konfiguration").first().json.ntfyServer }}'),
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.payload) }}'),
      options: { timeout: 30000 },
    },
    position: [1960, -100],
  },
});

const logOut = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Abmelden',
    parameters: {
      method: 'GET',
      url: expr('{{ $("Konfiguration").first().json.opacUrl }}/login.do?methodToCall=logout'),
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Cookie', value: expr('{{ $("Anmeldung prüfen").first().json.cookie }}') }],
      },
      options: {
        response: { response: { neverError: true, responseFormat: 'text', outputPropertyName: 'html' } },
        timeout: 30000,
      },
    },
    position: [1740, 220],
  },
});

export default workflow('bibliothek-verlaengerung', 'Bibliothek Braunschweig – Verlängerung')
  .add(dailyCheck)
  .to(configuration)
  .to(startSession)
  .to(sessionData)
  .to(logIn)
  .to(checkLogin)
  .to(noticePage
    .onTrue(confirmNotice.to(fetchLoans))
    .onFalse(fetchLoans))
  .add(fetchLoans)
  .to(readLoans)
  .to(renewalNeeded
    .onTrue(renewAll.to(refetchLoans).to(readResult).to(buildMessage))
    .onFalse(buildMessage))
  .add(buildMessage)
  .to(shouldNotify.onTrue(sendPush))
  .add(buildMessage)
  .to(logOut);
