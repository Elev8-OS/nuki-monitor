# Sonde vor Ort

Die Nuki Web API sagt nur, ob die **Nuki-Cloud** das Schloss erreicht. Diese Sonde sagt, ob das Schloss im **lokalen WLAN** erreichbar ist. Erst beide Messungen zusammen beantworten die Frage, die euch beschäftigt:

| Cloud sagt | Sonde sagt | Bedeutung |
|---|---|---|
| offline | erreichbar | Das Schloss hängt im WLAN, aber kommt nicht zu Nuki. Internetleitung oder Nuki-Cloud. |
| offline | nicht erreichbar | Das Schloss hat das WLAN verloren. Hier liegt es am Router. |
| online | nicht erreichbar | Sonde falsch konfiguriert oder Client-Isolierung im Netz aktiv. |

Die Sonde misst alle 15 Sekunden statt jede Minute. Damit werden auch Aussetzer sichtbar, die im Cloud-Polling durchrutschen.

**Aufwand realistisch einschätzen:** Das braucht Hardware am Standort. Für 20 Standorte ist das viel. Sinnvoll sind zwei oder drei Referenzstandorte — einer mit auffällig vielen Abbrüchen, einer mit wenigen. Was ihr dort lernt, gilt für den Rest.

---

## Was ihr braucht

- Ein Gerät im selben Netz wie das Schloss: Raspberry Pi Zero 2 W, alter Laptop, Mini-PC. Python 3 reicht, keine Bibliotheken.
- Die feste IP des Schlosses. Vergebt dafür in der Internet-Box eine DHCP-Reservierung, sonst misst ihr irgendwann die falsche Adresse.
- Den Standortnamen **genau so**, wie er im Monitor unter Standorte angelegt ist.
- Das `PROBE_TOKEN` aus den Railway-Variablen.

---

## Starten

```bash
export MONITOR_URL=https://dein-monitor.up.railway.app
export PROBE_TOKEN=dasselbe-wie-in-railway
python3 probe.py --site "Villa Nord" --target 192.168.1.42
```

Als Dienst, damit sie einen Neustart übersteht — `/etc/systemd/system/nuki-probe.service`:

```ini
[Unit]
Description=Nuki Sonde
After=network-online.target

[Service]
Environment=MONITOR_URL=https://dein-monitor.up.railway.app
Environment=PROBE_TOKEN=dasselbe-wie-in-railway
ExecStart=/usr/bin/python3 /opt/nuki-probe/probe.py --site "Villa Nord" --target 192.168.1.42
Restart=always
RestartSec=10
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nuki-probe
journalctl -u nuki-probe -f
```

Bricht die Verbindung zum Monitor ab, sammelt die Sonde die Messwerte und schickt sie nach, bis maximal 500 Stück.

---

## Daten aus der Internet-Box

Die Internet-Box hat einen lokalen `/ws`-Endpunkt, über den man Gerätestatus, WAN-Zustand, WLAN-Netze und verbundene Clients auslesen kann. Es gibt dafür Community-Werkzeuge, unter anderem einen Python-Client und eine Home-Assistant-Integration.

Drei Dinge solltet ihr vorher wissen:

1. **Der Zugang ist nicht offiziell dokumentiert.** Swisscom hat ihn mit Firmware-Updates schon mehrfach verändert; die Home-Assistant-Integration ist dadurch zeitweise komplett ausgefallen. Verlasst euch nicht darauf.
2. **Er ist nur lokal erreichbar.** Von aussen kommt ihr nicht an die Box, deshalb braucht es die Sonde als Vermittler.
3. **Er braucht das Admin-Passwort der Box.**

Aktivieren:

```bash
export ROUTER_HOST=192.168.1.1
export ROUTER_USER=admin
export ROUTER_PASSWORD=euer-box-passwort
```

Die Sonde fragt den Router nur dann ab, wenn das Schloss gerade nicht antwortet. Das hält die Last niedrig und liefert Kontext genau dann, wenn er gebraucht wird. Scheitert die Abfrage, misst die Sonde ohne sie weiter und legt die Fehlermeldung in den Rohdaten ab.

Das Ergebnis landet im Feld `raw` des Messwerts und ist über `/api/probes` und die Datenbank auswertbar. Erwartet hier keine fertige Auswertung: welche Felder die Box liefert, hängt von ihrer Firmware ab. Schaut euch die ersten Rohdaten an und sagt mir, was drinsteht, dann baue ich die passende Auswertung.

---

## Was die Sonde nicht kann

- **Kein RSSI vom Schloss.** Die Signalstärke kennt nur das Schloss selbst, und die zeigt ausschliesslich die Nuki App unter Verbindungsstatus.
- **Ping ist keine WLAN-Diagnose.** Ihr seht, dass das Schloss weg ist, nicht warum. Für den Grund braucht es die Deauth-Reason-Codes aus dem Router-Log, und die gibt die Internet-Box nicht ohne Weiteres heraus.
- **Das Schloss schläft.** Antwortet es im Schlafmodus nicht auf Ping, obwohl es verbunden ist, entstehen Fehlalarme. Prüft das am ersten Standort, bevor ihr die Sonde ausrollt: Wenn die Sonde dauernd Fehlschläge meldet, während die Cloud das Schloss als online führt, ist genau das der Fall — dann taugt die Sonde nur für den Vergleich untereinander, nicht als absolutes Mass.
