<p align="center">
  <img src="logo.png" alt="WARP3 Chargelog" width="128">
</p>

# WARP3 Wallbox Ladeabrechnung

Home Assistant Add-on für konsolidierte Ladeabrechnung mehrerer [Tinkerforge WARP3](https://www.warp-charger.com/) Wallboxen.

![Home Assistant](https://img.shields.io/badge/Home%20Assistant-Add--on-blue) ![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Automatische Erkennung** der Wallboxen im Netzwerk per mDNS
- **Alle Ladevorgänge** von mehreren WARP3 Wallboxen konsolidiert
- **Benutzer-, Monats- und Jahresfilter** – Auswahl wird sofort übernommen
- **Strompreis** und **Benutzernamen** direkt aus der Wallbox-API
- **PDF-Export** im aktuellen WARP-Ladelog-Design (Redesign der Firmware vom Oktober 2026, Layout aus dem [Firmware-Quellcode](https://github.com/Tinkerforge/esp32-firmware/blob/master/software/src/modules/charge_tracker/pdf_charge_log.cpp)) – mit Kennzahlen-Kacheln, Start/Ende, Wallbox, End-Zählerstand, Summenzeile sowie Übersichten nach Benutzer und Wallbox
- **Briefkopf/Firmenadresse** über die Weboberfläche konfigurierbar
- **Daten-Caching** – schnelle Seitenaufrufe, manuelles Aktualisieren möglich

## Installation

1. In Home Assistant zu **Einstellungen → Add-ons → Add-on Store** navigieren
2. Oben rechts auf **⋮ → Repositories** klicken
3. Repository-URL hinzufügen:
   ```
   https://github.com/TMA84/warp3-chargelog
   ```
4. **WARP3 Ladeabrechnung** in der Liste finden und installieren
5. Add-on starten

## Konfiguration

Die Wallboxen werden automatisch per mDNS im Netzwerk gefunden – in der Regel ist keine manuelle Konfiguration nötig.

Optional können Wallboxen und Firmenadresse in der Datei `/addon_configs/warp3-chargelog/config.yaml` manuell angegeben werden:

```yaml
port: 8099

# Optional: Wallboxen manuell angeben
wallboxes:
  - host: "warp3-AbCd"
  - host: "warp3-EfGh"

# Optional: Zeitzone für Datumsanzeige und Filter (Standard: Europe/Berlin,
# wie die Ortszeit der Wallboxen)
timezone: "Europe/Berlin"

# Firmenadresse (auch über Weboberfläche änderbar)
company:
  name: "Musterfirma GmbH"
  street: "Musterstraße 1"
  city: "12345 Musterstadt"
```

## Verwendung

Nach dem Start ist die Weboberfläche erreichbar unter:

→ **http://\<home-assistant-ip\>:8099**

1. **Filtern** – Benutzer, Jahr und Monat über die Dropdowns auswählen
2. **PDF Export** – Erzeugt ein PDF im WARP-Ladelog-Design mit Logo, Briefkopf, Kennzahlen, Tabelle und Übersichten
3. **⚙ Briefkopf** – Firmenadresse für den PDF-Header konfigurieren
4. **↻ Aktualisieren** – Cache leeren und frische Daten von den Wallboxen holen

## Unterstützte Architekturen

| Architektur | Verfügbar |
|---|---|
| amd64 | ✅ |
| aarch64 | ✅ |
| armv7 | ✅ |

## Genutzte WARP3 API-Endpunkte

| Endpunkt | Beschreibung |
|---|---|
| `GET /charge_tracker/charge_log` | Binäres Ladelog aller Ladevorgänge (inkl. Zählerstand) |
| `GET /charge_tracker/config` | Strompreis (`electricity_price` in ct/kWh × 100) |
| `GET /users/config` | Benutzerliste mit IDs und Anzeigenamen |
| `GET /info/name` | Wallbox-Hostname und Gerätetyp |

## Technische Details

- **Node.js / Express** mit EJS-Templates
- **Eigener PDF-Generator** (`simplepdf.js`, Layout in `chargelogpdf.js`) – minimaler Speicherverbrauch
- **mDNS-Discovery** via `bonjour-service` – findet WARP-Charger automatisch im LAN
- **Host-Netzwerk** – erforderlich für mDNS-Discovery
- **Persistente Konfiguration** unter `/addon_configs/warp3-chargelog/`

## Lizenz

MIT
