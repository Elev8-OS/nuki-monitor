#!/usr/bin/env python3
"""
Sonde fuer einen Standort.

Laeuft auf einem beliebigen Geraet im selben Netz wie das Schloss - Raspberry Pi,
alter Laptop, Mini-PC - und misst alle paar Sekunden, ob das Schloss antwortet.
Das Ergebnis geht gebuendelt an den Nuki Monitor.

Warum das ueberhaupt: Die Nuki Web API sagt nur, ob die Nuki-Cloud das Schloss
erreicht. Diese Sonde sagt, ob das Schloss im lokalen WLAN erreichbar ist.
Erst beide Messungen zusammen unterscheiden ein WLAN-Problem von einem
Cloud-Problem.

Optional liest die Sonde zusaetzlich die lokale API der Swisscom Internet-Box
(/ws auf 192.168.1.1) und schickt WAN-Status und WLAN-Informationen mit.
Achtung: Dieser Zugang ist nicht offiziell dokumentiert und wurde durch
Firmware-Updates schon mehrfach veraendert. Faellt er aus, misst die Sonde
einfach ohne ihn weiter.

Aufruf:
    export MONITOR_URL=https://dein-monitor.up.railway.app
    export PROBE_TOKEN=...
    python3 probe.py --site "Villa Nord" --target 192.168.1.42

Als Dienst einrichten: siehe README.md in diesem Ordner.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

MONITOR_URL = os.environ.get("MONITOR_URL", "").rstrip("/")
PROBE_TOKEN = os.environ.get("PROBE_TOKEN", "")
ROUTER_HOST = os.environ.get("ROUTER_HOST", "")
ROUTER_USER = os.environ.get("ROUTER_USER", "admin")
ROUTER_PASSWORD = os.environ.get("ROUTER_PASSWORD", "")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ping(target, timeout=2):
    """Ein einzelner Ping. Gibt (erreichbar, Antwortzeit in ms) zurueck."""
    started = time.monotonic()
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(timeout), target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout + 2,
        )
        rtt = (time.monotonic() - started) * 1000
        return result.returncode == 0, round(rtt, 1)
    except Exception:
        return False, None


def read_router():
    """
    Liest optional Kennzahlen der Internet-Box. Der /ws-Endpunkt ist inoffiziell;
    schlaegt er fehl, liefert die Funktion einfach nichts.
    """
    if not ROUTER_HOST:
        return {}

    payload = json.dumps(
        {"service": "NMC", "method": "getWANStatus", "parameters": {}}
    ).encode("utf-8")

    request = urllib.request.Request(
        f"http://{ROUTER_HOST}/ws",
        data=payload,
        headers={
            "Content-Type": "application/x-sah-ws-4-call+json",
            "Authorization": "X-Sah-Login",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return {"router": json.loads(response.read().decode("utf-8"))}
    except Exception as error:  # noqa: BLE001 - Router-Zugriff darf nie stoeren
        return {"router_error": str(error)[:200]}


def send(site, samples):
    if not MONITOR_URL or not PROBE_TOKEN:
        print("MONITOR_URL oder PROBE_TOKEN fehlt.", file=sys.stderr)
        return False

    body = json.dumps({"site": site, "samples": samples}).encode("utf-8")
    request = urllib.request.Request(
        f"{MONITOR_URL}/api/probe",
        data=body,
        headers={"Content-Type": "application/json", "X-Probe-Token": PROBE_TOKEN},
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status == 200
    except urllib.error.HTTPError as error:
        print(f"Monitor antwortete mit {error.code}: {error.read()[:200]}", file=sys.stderr)
    except Exception as error:  # noqa: BLE001
        print(f"Senden fehlgeschlagen: {error}", file=sys.stderr)
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True, help="Standortname genau wie im Monitor angelegt")
    parser.add_argument("--target", required=True, help="IP-Adresse des Schlosses")
    parser.add_argument("--interval", type=int, default=15, help="Sekunden zwischen zwei Messungen")
    parser.add_argument("--batch", type=int, default=20, help="Messungen pro Uebertragung")
    args = parser.parse_args()

    print(f"Sonde laeuft: {args.site} -> {args.target}, alle {args.interval} s")
    buffer = []

    while True:
        reachable, rtt = ping(args.target)
        sample = {
            "measured_at": now_iso(),
            "target": args.target,
            "reachable": reachable,
            "rtt_ms": rtt,
            "source": "probe",
        }

        if not reachable:
            # Nur im Fehlerfall den Router befragen: das haelt die Last niedrig
            # und liefert genau dann Kontext, wenn er gebraucht wird.
            sample["raw"] = read_router()

        buffer.append(sample)

        if len(buffer) >= args.batch:
            if send(args.site, buffer):
                buffer = []
            elif len(buffer) > 500:
                # Verbindung zum Monitor laenger weg: aeltere Messungen verwerfen,
                # damit die Sonde nicht unbegrenzt Speicher frisst.
                buffer = buffer[-500:]

        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nSonde beendet.")
