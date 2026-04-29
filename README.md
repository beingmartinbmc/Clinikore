# Clinikore

An **offline clinic management desktop app** for a doctor's laptop. Runs entirely
on the local machine — the data never leaves the device.

- **Backend:** FastAPI + SQLModel + SQLite (`~/.clinikore/clinic.db`)
- **Frontend:** React + Vite + TailwindCSS + FullCalendar + lucide-react
- **Desktop shell:** PyWebView (native window wrapping the local FastAPI server)
- **Invoices:** PDF generated via ReportLab

## Features

- **Patients** — profile (name, age, phone, email), medical & dental history, allergies, notes
- **Treatments** — procedure-based history per patient, tooth & notes
- **Calendar** — day / week / month view with slot-based booking and drag-to-select
- **Appointments** — scheduled / completed / cancelled, with SMS / WhatsApp reminder hooks
- **Procedures** — catalog with default pricing
- **Invoices** — auto totals from line items, PDF export, per-invoice payment tracking
- **Payments** — cash / UPI / card, with references, auto-updates invoice status
- **Dashboard** — today's appointments, pending dues, month revenue
- **Backups** — automatic SQLite + CSV snapshots every few hours, downloadable zip
- **Guided demo mode** — first-launch welcome modal loads realistic sample data and
  walks the doctor through every tab; re-openable from the sidebar's **Help & tour**
  button. Clearing demo data never touches real records (tagged via `[DEMO]`).

## Directory layout

```
doctor-helper/
├── launcher.py             # Desktop launcher (pywebview + embedded uvicorn)
├── requirements.txt
├── backend/
│   ├── main.py             # FastAPI app + all routes
│   ├── models.py           # SQLModel tables and schemas
│   ├── db.py               # Engine / session / init
│   └── services.py         # Invoice PDF + reminder stubs
└── frontend/
    ├── package.json
    ├── src/
    │   ├── App.tsx
    │   ├── api.ts          # Typed API client + types
    │   ├── components/     # Layout, Modal, StatusBadge, PageHeader
    │   └── pages/          # Dashboard, Patients, PatientDetail, Calendar,
    │                       #   Procedures, Invoices, InvoiceDetail
    └── vite.config.ts
```

## Cross-platform support

| OS | Python | WebView backend | Extra steps |
|----|--------|-----------------|-------------|
| macOS 11+ | 3.10+ | Cocoa WebKit (built-in) | none |
| Windows 7 SP1 x86 (patched) | bundled Python 3.8.10 32-bit | Chrome/default browser fallback | try `win-x86`; if Python DLL/procedure errors appear, use `win7-legacy-x86` |
| Windows 7 SP1 x64 (patched) | bundled Python 3.8.10 64-bit | Chrome/default browser fallback | try `win-x64`; if Python DLL/procedure errors appear, use `win7-legacy-x64` |
| Windows 7 SP1 base/unpatched | bundled Python 3.7.9 + Pydantic v1 | Chrome/default browser fallback | download the matching `win7-legacy-*` installer; install Chrome/Chromium if no default browser is available |
| Windows 10/11 x86 | bundled Python 3.8.10 32-bit for packaged installer; 3.8-3.13 for source installs | Edge WebView2 | download the `win-x86` installer; [install WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if missing |
| Windows 10/11 x64 | bundled Python 3.8.10 for packaged installer; 3.8-3.13 for source installs | Edge WebView2 (built-in on Win 11/recent Win 10) | [Install WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if missing |
| Linux (Ubuntu/Fedora/Arch) | 3.10+ | Qt (PyQt5) | `sudo apt install libxcb-xinerama0 libgl1` (Debian/Ubuntu) |

The `requirements.txt` installs `pywebview[qt]` only on Linux via a PEP 508
marker, so macOS/Windows users don't get extra GUI dependencies.

## One-click install & run (recommended)

Every OS has a matched pair of scripts in `scripts/`:

| Step | macOS | Linux | Windows |
|---|---|---|---|
| **1. Install once** | Double-click `scripts/install.command` | `bash scripts/install.command` | Double-click `scripts\install.bat` |
| **2. Launch anytime** | Double-click `scripts/run.command` | `bash scripts/run.command` | Double-click `scripts\run.bat` |

The installer:

- Verifies Python 3.8+ on Windows / 3.9+ elsewhere (Windows 7 must use
  Python 3.8.x for source installs).
- Verifies Node.js 18+ — **skipped entirely** if `frontend/dist` is pre-built (see below).
- Creates the `.venv`, installs every Python dependency, builds the React UI.
- Is idempotent — safe to re-run after updates.

The launcher assumes install is done and just starts the desktop window.

## Shipping the app to a non-technical doctor

### ⭐ Windows — build a proper `Setup.exe` (recommended for commercial distribution)

The doctor downloads the installer that matches their Windows architecture,
double-clicks it, and gets a real Windows install wizard with Desktop + Start
Menu shortcuts. Zero Python, zero Node, zero scripts on their machine.

GitHub Releases publish four Windows files:

- `Clinikore-Setup-<version>-win-x64.exe` — most Windows 7/10/11 laptops.
- `Clinikore-Setup-<version>-win-x86.exe` — only for 32-bit Windows.
- `Clinikore-Setup-<version>-win7-legacy-x64.exe` — 64-bit base/unpatched Windows 7.
- `Clinikore-Setup-<version>-win7-legacy-x86.exe` — 32-bit base/unpatched Windows 7.

If unsure, try `win-x64` first. If Windows says the installer is not compatible
with the computer, use `win-x86`. If Windows 7 shows `Failed to load Python DLL`
or `The specified procedure could not be found`, use the matching
`win7-legacy-*` installer.

**You** (the developer) can also build installers locally on a Windows machine
with Python 3.8.10 installed for the target architecture:

```cmd
installer\build.bat x64
installer\build.bat x86
installer\build.bat win7-legacy-x64
installer\build.bat win7-legacy-x86
```

It chains PyInstaller (bundles the selected Python runtime + all deps + the
React UI into one folder) and Inno Setup 6 (wraps that into a signed-ready
Setup wizard). The resulting files in `dist\installer\` support Windows 7 SP1,
Windows 10, and Windows 11. See `installer/README.md` for full build
instructions, prerequisites, version bumps, and code-signing notes.

### macOS / Linux — zip + script (simpler, works today)

macOS and Linux users don't yet have a packaged installer, but the script
flow is clean:

1. Pre-build the frontend on your machine: `cd frontend && npm install && npm run build`.
2. Zip the repo **including** `frontend/dist/` and **excluding** `.venv`,
   `frontend/node_modules`, `frontend/src`, `frontend/package*.json`.
3. Give them the zip and tell them to:
   - Install Python 3.12 from python.org.
   - Double-click `scripts/install.command` (mac) or run it from a terminal (Linux).
   - Double-click `scripts/run.command` thereafter.

Because the frontend is pre-built, the doctor never needs Node.

### Fallback — source-based install on Windows

If you don't want to bother with Inno Setup, you can also ship the source
zip and tell the Windows doctor to double-click `scripts\install.bat` (it
creates a Desktop shortcut) and then the `Clinikore` icon on their Desktop.
This needs Python on their machine but is a simpler build-time story for you.
Use Python 3.8.10 on Windows 7; Python 3.12+ is fine on Windows 10/11.

## First-time setup (manual)

### 1. Backend (Python 3.10+; Windows source installs support 3.8+)

**macOS / Linux**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Windows (PowerShell)**
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

**Windows (cmd)**
```cmd
python -m venv .venv
.venv\Scripts\activate.bat
pip install -r requirements.txt
```

### 2. Frontend (Node 18+)

```bash
cd frontend
npm install
npm run build                    # produces frontend/dist/
```

The build output is automatically served by FastAPI when you launch the app.

## Running

### As a desktop app (production)

```bash
python launcher.py
```

This boots uvicorn on `127.0.0.1:8765`, waits for it to be healthy, and opens
a PyWebView window. Works identically on macOS, Windows and Linux.

### Developing the frontend with hot reload

Terminal 1 — backend only:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765 --reload
```

Terminal 2 — Vite dev server (proxies `/api` to 8765):

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>.

## Where is my data?

SQLite database and any future attachments live under:

- macOS / Linux: `~/.clinikore/clinic.db`
- Windows: `%USERPROFILE%\.clinikore\clinic.db`

Override with `CLINIKORE_HOME=/some/path` (legacy name `DOCTOR_HELPER_HOME` still works).

## Data protection & backups

This is patient data — losing it is unacceptable. The app takes care of it for
you with a **defense-in-depth** strategy:

### What happens automatically

1. **Snapshot at every app launch** — before anything else.
2. **Periodic snapshots** every `BACKUP_INTERVAL_HOURS` (default: 6 hours) for as
   long as the app is running.
3. Each snapshot folder contains:
   - `clinic.db` — consistent SQLite snapshot taken via the online backup API
     (safe even while the DB is being written).
   - `csv/<table>.csv` — a full CSV export of every table. Human-readable, can
     be opened in Excel, and recoverable even if the SQLite format itself is
     ever inaccessible. This is the "your data can never be lost" tier.
   - `manifest.json` — timestamp, row counts, SQLite version.
4. **Automatic pruning** keeps only the last `BACKUP_KEEP` snapshots
   (default: 30) to bound disk usage.

Snapshots live at:

- macOS / Linux: `~/.clinikore/backups/<YYYYMMDD-HHMMSS>/`
- Windows: `%USERPROFILE%\.clinikore\backups\<YYYYMMDD-HHMMSS>\`

### The **Backups** tab in the UI

- Lists every snapshot with size, timestamp, and record count.
- **Backup now** button — take an extra snapshot on demand.
- **Download `.zip`** — get a single zipped archive you can drop on a USB stick
  or upload to Google Drive / Dropbox for **offsite** protection.
- **Delete** — remove old snapshots (rarely needed; auto-prune handles this).

### Configuration (env vars)

| Variable | Default | Effect |
|---|---|---|
| `BACKUP_INTERVAL_HOURS` | `6` | How often periodic snapshots are taken |
| `BACKUP_KEEP` | `30` | How many snapshots to retain before auto-pruning |
| `BACKUP_ON_STARTUP` | `1` | Set to `0` to skip the boot-time snapshot |
| `CLINIKORE_HOME` | `~/.clinikore` | Base directory for DB and backups |

### Restoring

To restore from any snapshot:

1. Quit the app.
2. Replace `~/.clinikore/clinic.db` with the `clinic.db` from the desired
   snapshot folder.
3. Launch the app again — it picks up right where the snapshot left off.

### Strongly recommended: offsite backups

Automatic snapshots live on the **same laptop** as the main database. That
protects against accidental deletes and data corruption, but not against
theft, fire, or a failing SSD. **Once a week**, download the latest snapshot
zip from the Backups tab and copy it to a USB stick or cloud storage.

A future version can automate this (rclone/rsync to a configured path); the
foundation is already in place.

## Clinic branding on invoices

Set these env vars before launching to customize invoice PDFs:

```
CLINIC_NAME="Dr. Smile Dental Care"
CLINIC_ADDRESS="12 Main Rd, Bengaluru 560001"
CLINIC_PHONE="+91 98765 43210"
```

## Enabling real SMS / WhatsApp reminders

By default reminders are **logged to the console** — everything else works
offline. To send real messages, edit `backend/services.py`:

- `_send_sms(phone, message)` — plug in Twilio / MSG91 / AWS SNS / Fast2SMS.
- `_send_whatsapp(phone, message)` — plug in the WhatsApp Cloud API or Twilio
  WhatsApp.

Store API keys in environment variables — never hardcode them.

## Packaging

- **Windows** — see `installer/README.md`. One command produces a Setup.exe
  with a wizard, Desktop & Start Menu shortcuts, and a proper uninstaller.
- **macOS** — `pyinstaller --windowed --name Clinikore --add-data "frontend/dist:frontend/dist" launcher.py`
  then wrap `dist/Clinikore.app` in a DMG with `create-dmg` (roadmap).
- **Linux** — `pyinstaller --name Clinikore --add-data "frontend/dist:frontend/dist" launcher.py`
  then ship as AppImage or .deb (roadmap).

## Testing

The project ships with a full pytest-based end-to-end test suite that
exercises every calculation path: patient lifecycle, appointments,
treatments, consultation notes (prescriptions), treatment plans, invoice
totals & discounts, multi-installment payments, PDF + HTML receipt
generation, reports, dashboard aggregation, soft-delete / undo,
DB-backed audit log, demo seeding, and backup creation.

Layout:

```
tests/
├── conftest.py                   # isolated tmp CLINIKORE_HOME + per-test DB reset
├── test_patients.py
├── test_procedures.py
├── test_appointments.py
├── test_treatments.py
├── test_consultation_notes.py    # prescription-like records
├── test_treatment_plans.py
├── test_invoices_payments.py     # every discount / status / repayment path
├── test_invoice_documents.py     # PDF + printable HTML receipt
├── test_reports.py               # daily / monthly aggregates + CSVs
├── test_dashboard.py
├── test_lifecycle.py             # computed patient status
├── test_undo.py                  # in-memory undo token buffer
├── test_audit_db.py              # DB-backed audit log
├── test_demo_and_backup.py
├── test_settings.py
└── test_e2e_workflows.py         # full patient→consult→invoice→pay→print→report flow
```

Run:

```bash
pip install -r requirements.txt    # pytest is listed there
pytest
```

Tests create a fresh temporary `CLINIKORE_HOME` per session and truncate
every table between tests, so ordering is irrelevant and no real data is
touched. A few tests are marked `xfail` with a clear reason — those pin
down known server-side bugs (double-add in `add_payment`, scalar unpack
in the procedure-categories endpoint) so they start passing the moment
the bug is fixed.

## License

MIT — do whatever you want with it.
