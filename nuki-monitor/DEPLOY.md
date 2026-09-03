# Deploy — Kurzanleitung

## Warum bisher nichts lief

Das Dashboard war zu sehen, aber es kam keine Anmeldeabfrage und jeder Pfad unter `/api/` ergab einen leeren 404. Beides zusammen heisst: Es antwortete kein Node-Server, sondern ein statischer Webserver, der einfach `public/index.html` ausgeliefert hat.

Dagegen liegen jetzt drei Dateien bei, die den Node-Weg erzwingen: `railway.json`, `nixpacks.toml` und `Procfile`. Eine davon hätte gereicht, zusammen sind sie eindeutig.

---

## Dateien

Genau diese Struktur muss im Repository stehen. Das ZIP entpackt sie korrekt — bitte nicht flach in einen Ordner kopieren.

```
nuki-monitor/
├── package.json          Startbefehl und Abhängigkeiten
├── package-lock.json
├── railway.json          Builder und Startbefehl für Railway
├── nixpacks.toml         erzwingt den Node-Provider
├── Procfile              Fallback für den Startbefehl
├── .nvmrc                Node 20
├── .gitignore
├── .env.example
├── server.js             HTTP-Server und Routen
├── README.md
├── DEPLOY.md             diese Datei
├── src/
│   ├── db.js             Schema, Abfragen, Verbindungspool
│   ├── nuki.js           Nuki Web API, Zustandscodes, Firmware
│   ├── poller.js         Abfrage und Zustandsvergleich
│   ├── analysis.js       Ausfälle, Abdeckung, Vergleich
│   ├── alerts.js         Alarme und Webhook-Versand
│   ├── webhook.js        Empfänger für Nuki, Signaturprüfung
│   └── oauth.js          Webhook-Einrichtung mit Nuki
├── public/
│   ├── index.html        Dashboard
│   └── setup.html        Standorte, Änderungen, Webhooks
├── scripts/
│   └── webhook.mjs       Webhook von Hand verwalten
├── probe/
│   ├── probe.py          Sonde für den Einsatz vor Ort
│   └── README.md
└── test/
    └── smoke.test.js     läuft ohne echte API und ohne Postgres
```

---

## Schritte

1. ZIP entpacken, Inhalt in den Repository-Ordner legen. Vorhandene Dateien überschreiben.
2. In GitHub Desktop prüfen, dass die neuen Dateien in den Änderungen auftauchen, besonders `railway.json` und `nixpacks.toml`. Committen und pushen.
3. Railway deployt automatisch. Warten, bis der Deploy grün ist.

---

## Sofort prüfen

```
https://nuki-monitor-production.up.railway.app/healthz
```

Erwartet wird JSON in dieser Form:

```json
{
  "app": "nuki-monitor",
  "version": "3.0.0",
  "ok": true,
  "auth_required": true,
  "database": "verbunden"
}
```

Dieser Pfad braucht bewusst kein Passwort, damit Railway ihn für den Healthcheck nutzen kann.

| Was du siehst | Was es bedeutet |
|---|---|
| JSON mit `"database": "verbunden"` | Alles läuft. Weiter mit `/setup`. |
| JSON, aber `"database"` meldet einen Fehler | Der Dienst läuft, die Datenbank nicht. Prüfe `DATABASE_URL` und `DATABASE_SSL`. |
| JSON mit `"auth_required": false` | `DASHBOARD_PASSWORD` kommt nicht an. Variable prüfen. |
| Chromes 404-Seite | Der Container läuft nicht. Deploy Logs ansehen. |
| Weiterhin keine Anmeldeabfrage auf `/` | Es antwortet immer noch ein statischer Server. Prüfe in den Build Logs, ob wirklich `node server.js` gestartet wurde. |

In den Deploy Logs muss stehen:

```
Nuki Monitor 3.0.0 laeuft auf Port 8080
Zugriffsschutz aktiv.
Datenbank bereit.
Polling alle 60 Sekunden.
```

Fehlt die erste Zeile, ist der Node-Prozess nie gestartet — dann liegt es am Build, nicht am Code.

---

## Variablen

Pflicht: `NUKI_API_TOKEN`, `DATABASE_URL`, `DASHBOARD_USER`, `DASHBOARD_PASSWORD`.

`DATABASE_URL` als Referenz `${{Postgres.DATABASE_URL}}` eintragen. Bei der internen Adresse (`postgres.railway.internal`) gehört `DATABASE_SSL` auf `false`, bei der öffentlichen Proxy-Adresse auf `true`.

Für Webhooks zusätzlich `NUKI_CLIENT_ID`, `NUKI_CLIENT_SECRET` und `PUBLIC_URL` — Letzteres ohne Schrägstrich am Ende.

---

## Hinweis zur eigenen Domain

`nuki.elev8-suite.com` erst dann verwenden, wenn die Railway-Adresse sauber antwortet. Sonst weisst du bei einem Fehler nicht, ob es an der App oder am DNS liegt. Läuft die Railway-Adresse und eure Domain nicht, liegt es am CNAME oder an einem Proxy davor.
