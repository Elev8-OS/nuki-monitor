# Nuki Monitor

Fragt die Nuki Web API im Minutentakt ab, schreibt jeden Zustandswechsel nach Postgres, alarmiert über einen Webhook und rechnet aus, ob eine Router-Umstellung tatsächlich etwas gebracht hat.

Der Unterschied zu Nuki Web und zu Seam: Nuki liefert nur den Zustand von jetzt, Seam pollt alle zehn Minuten. Diese App pollt jede Minute, behält die Historie und kennt euren Kontext — welches Schloss an welchem Router hängt und wann ihr dort was geändert habt.

---

## Aufsetzen auf Railway

1. Ordner in ein Git-Repository legen und pushen.
2. Railway: **New Project → Deploy from GitHub repo**.
3. Im selben Projekt **New → Database → Add PostgreSQL**.
4. Beim App-Service unter **Variables** setzen:

   | Variable | Wert |
   |---|---|
   | `NUKI_API_TOKEN` | Token aus Nuki Web, Menü → API |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` als Referenz, nicht abtippen |
   | `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | Zugriffsschutz, unbedingt setzen |
   | `ALERT_WEBHOOK_URL` | wohin die Alarme gehen |
   | `ALERT_WEBHOOK_SECRET` | frei wählen, kommt als Header mit |
   | `PUBLIC_URL` | die Railway-Domain, erscheint in jedem Alarm |
   | `PROBE_TOKEN` | nur nötig, wenn ihr Sonden vor Ort einsetzt |

5. **Settings → Networking → Generate Domain**, Seite öffnen.

Tabellen legt die App beim Start selbst an. Healthcheck ist `/healthz`, absichtlich ohne Login.

Lokal:

```bash
npm install
NUKI_API_TOKEN=... DATABASE_URL=postgres://... npm start
npm test    # läuft ohne echte API und ohne externen Postgres
```

---

## So arbeitet ihr damit

**1. Einrichten.** Unter *Standorte & Änderungen* für jeden Router einen Standort anlegen, mit Modell, WPA-Modus, Kanal und ob eine WLAN-Box im Spiel ist. Danach jedes Schloss seinem Standort zuordnen. Ohne Zuordnung gibt es keinen Standortvergleich und keine Wirkungsmessung.

**2. Messen, bevor ihr etwas ändert.** Mindestens 72 Stunden laufen lassen. Das Dashboard zeigt euch die Messabdeckung; liegt sie unter 95 Prozent, hattet ihr Lücken und die Zahlen taugen noch nicht als Ausgangswert.

**3. Ändern und eintragen.** Umstellung an der Internet-Box machen, dann unter *Änderungen* eintragen: was, welcher Standort, wann.

**4. Wirkung ablesen.** Nach 72 Stunden steht im Dashboard unter *Wirkung der Änderungen* der Vergleich: Abbrüche und Ausfallzeit im gleich langen Fenster davor und danach, nur für die Schlösser des betroffenen Standorts, mit einer Bewertung von *deutlich besser* bis *schlechter*. Solange zu wenig Zeit vergangen ist, steht dort *zu früh* statt einer vorschnellen Aussage.

**5. Eskalieren.** Reicht es nicht, liefern die beiden CSV-Exporte den Anhang für den Nuki-Support: eine Übersicht pro Schloss mit Router-Merkmalen und eine Liste aller Ausfälle mit Zeitstempeln.

---

## Alarme

Ein Schloss löst aus, wenn es länger als `ALERT_AFTER_MINUTES` offline ist — nicht sofort, damit kurze Aussetzer nicht dauernd das Team wecken. Kommt es zurück, gibt es eine Entwarnung mit der Dauer.

Gehen `FLEET_ALERT_THRESHOLD` Schlösser innerhalb weniger Minuten offline, kommt ein eigener Alarm mit höherer Dringlichkeit. Das ist die Unterscheidung, auf die es ankommt: mehrere Standorte gleichzeitig heisst, die Ursache liegt nicht am einzelnen Router.

Der Webhook bekommt JSON per POST, mit `X-Monitor-Secret` im Header:

```json
{
  "type": "lock_offline",
  "severity": "warning",
  "smartlock_id": "12345",
  "name": "Villa Nord Haustür",
  "site": "Villa Nord",
  "offline_since": "2026-09-03T14:12:00.000Z",
  "offline_minutes": 17,
  "message": "Villa Nord Haustür (Villa Nord) ist seit 17 Minuten offline.",
  "dashboard_url": "https://…"
}
```

Typen: `lock_offline`, `lock_recovered`, `fleet_outage`, `fleet_recovered`, `test`. In Make hängt ihr einen Webhook-Trigger davor und verteilt von dort nach Slack, E-Mail oder ins Ticketsystem. Der Testknopf auf der Setup-Seite schickt eine Nachricht mit `type: test`.

Ein nicht erreichbarer Webhook wird geloggt, stoppt aber nie das Polling.

---

## Was das Dashboard zeigt

- **Messabdeckung** — wie viel des Zeitraums tatsächlich gemessen wurde. Lücken erscheinen im Verlaufsbalken schraffiert, damit niemand einen Neustart der App für eine stabile Phase hält.
- **standortübergreifend** — Abbrüche, die mit dem Abbruch eines anderen Schlosses zusammenfielen.
- **Standorttabelle** — Abbrüche pro Schloss, damit grosse und kleine Standorte vergleichbar bleiben, mit den Router-Merkmalen daneben.
- **Verlaufsbalken** — rote Abschnitte sind Ausfälle, gelbe Striche sind Firmware-Wechsel und eure eingetragenen Änderungen.
- **Akkuverlauf** — im Detail jedes Schlosses, in Prozentpunkten pro Tag. Ein steilerer Abfall ist ein unabhängiges Indiz für Reconnect-Schleifen, auch wenn die einzelnen Aussetzer zu kurz zum Messen sind.

---

## Daten vom Router

Siehe `probe/README.md`. Kurz: Die Internet-Box hat einen lokalen, inoffiziellen `/ws`-Endpunkt, den man nur aus dem Netz des Standorts erreicht. Es braucht also ein Gerät vor Ort. Das mitgelieferte Sonden-Skript misst das Schloss alle 15 Sekunden per Ping und meldet an `/api/probe`. Erst damit unterscheidet ihr sauber zwischen „Schloss hat das WLAN verloren" und „Nuki-Cloud erreicht das Schloss nicht".

Für zwei oder drei Referenzstandorte lohnt sich das. Für alle wäre es unverhältnismässig.

---

## Zwei Annahmen, die ihr beim ersten Lauf prüfen solltet

**Online-Erkennung.** Die App wertet `serverState === 0` als online. Nuki dokumentiert weitere Codes, deren genaue Bedeutung ich nicht verifizieren konnte. Der Rohwert steht im Tooltip des Statuspunkts. Schaut beim ersten echten Ausfall nach, welcher Code auftaucht.

**Firmware-Dekodierung.** Nuki liefert die Firmware als Ganzzahl; die App rechnet `major * 65536 + minor * 256 + patch`, aus 329988 wird 5.9.4. Weicht das von der Nuki App ab, ist die Kodierung anders. Der Rohwert wird immer mitgespeichert.

---

## Grenzen

- Ein Aussetzer von unter einer Minute kann im Cloud-Polling durchrutschen. Mit Sonde vor Ort sind es 15 Sekunden.
- Die Cloud-Messung sieht die Nuki-Cloud, nicht das WLAN.
- RSSI und Verbindungsqualität liefert keine Nuki-API — nur die App unter Verbindungsstatus.
- Nuki dokumentiert Rate Limits. Bei 60 Sekunden und einem Aufruf pro Durchlauf seid ihr sehr wahrscheinlich weit darunter. Kommt ein 429, erhöht `POLL_INTERVAL_SECONDS`.

---

## API

| Pfad | Zweck |
|---|---|
| `GET /api/overview?days=7` | Aggregierte Auswertung samt Standorten und Messabdeckung |
| `GET /api/device?id=…&days=7` | Ereignisse, Messpunkte, Akkuverlauf, Rohdaten |
| `GET POST DELETE /api/sites` | Standorte verwalten |
| `POST /api/assign` | Schloss einem Standort zuordnen |
| `GET POST DELETE /api/changes` | Änderungen verwalten |
| `GET /api/compare?id=…&hours=72` | Vorher-Nachher-Vergleich einer Änderung |
| `GET /api/alerts`, `POST /api/alerts/test` | Alarme ansehen, Webhook testen |
| `POST /api/probe` | Ingest für die Sonden, Auth über `X-Probe-Token` |
| `GET /api/probes?days=7` | Auswertung der Sondendaten |
| `GET /api/export/summary.csv`, `/api/export/outages.csv` | Exporte für die Eskalation |
| `POST /api/poll` | Sofort abfragen |
| `GET /healthz` | Healthcheck ohne Login |
