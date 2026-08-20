# Edgevest Bulk Email Campaign Manager

Professional bulk email campaign tool for **Edgevest Training & Consultancy**.  
Build recipient lists, personalize Edgevest-branded templates, throttle sending, and monitor delivery in real time.

---

## Features

- **SMTP login** – Authenticate with your mail server credentials (session-based)
- **Recipients** – Paste lists or upload CSV (email, name, company); validate before send
- **Edgevest templates** – Visual editor with locked brand header/footer (gold accent, logo, NITA codes)
- **Merge tags** – `{name}`, `{email}`, `{company}` in subject and body
- **Attachments** – Upload files/PDFs or generate official receipt PDFs (jsPDF)
- **Throttle controls** – Limit emails per minute for shared hosting / reputation safety
- **Live monitor** – Progress stats, SSE log stream, pause / resume / stop
- **Clear workspace** – Reset recipients, template, attachments, and logs after a campaign
- **Unsubscribe** – Footer link with `{email}` placeholder

---

## Stack

| Layer | Technology |
|--------|------------|
| Backend | Node.js, Express (see `server.ts`) |
| Frontend (campaign UI) | Static `public/campaign.html` (Tailwind CDN, Font Awesome, jsPDF, SheetJS) |
| Optional UI | React / Vite under `src/` |
| Auth | Session / cookie (+ optional Bearer token in `localStorage`) |

---

## Requirements

- Node.js 18+ (recommended)
- SMTP account (e.g. Edgevest mail, Office 365, Gmail app password)
- Modern browser (Chrome, Edge, Firefox)

---

## Setup

```bash
git clone https://github.com/Oak-ke/email-campaign-app.git
cd email-campaign-app
npm install

EnvironmentCopy or create .env in the project root (adjust to your server / auth config):env

PORT=3000
SESSION_SECRET=change-me-to-a-long-random-string
# Optional admin / app password if used by your auth layer
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-secure-password
REQUIRE_LOGIN=true

Do not commit real passwords or production secrets.Run (development)bash

npm run dev

Open: http://localhost:3000
Campaign UI: http://localhost:3000/campaign.html
Login: http://localhost:3000/login.htmlRun (production)bash

npm run build   # if applicable
npm start

Serve over HTTPS in production so secure cookies and SMTP credentials stay protected.Campaign flow (4 steps)Recipients – Paste CSV-style lines or upload .csv → Parse & Validate  
Template – Edit body in the visual editor; header/footer stay Edgevest-branded  
Throttle – Set max emails per minute → Launch  
Live Monitor – Watch progress, logs; Pause / Resume / Stop; Clear workspace when done

CSV tip: export Excel as CSV (not .xlsx). Headers like email, name, company are supported.Main API routes (reference)Method
Path
Purpose
GET
/api/auth/check
Session status
POST
/api/auth/logout
Log out
POST
/api/smtp/verify
Test SMTP (login flow)
POST
/api/recipients/validate
Validate recipient list
POST
/api/campaign/start
Start campaign
GET
/api/campaign/status
Progress + logs
GET
/api/campaign/stream
SSE live updates
POST
/api/campaign/pause / resume / cancel
Controls
POST
/api/campaign/log/*
Add / edit / clear logs

Exact paths may vary slightly with your server.ts implementation.Project structure (high level)text

email-campaign-app/
├── public/
│   ├── campaign.html      # Main campaign wizard UI
│   ├── login.html         # SMTP / auth login
│   └── unsubscribe.html   # Unsubscribe page
├── src/                   # React / Vite app (if used)
├── server.ts              # Express API + static serving
├── package.json
└── README.md

Security notesAlways use HTTPS in production  
Prefer app-specific passwords for Gmail / Microsoft  
Keep rate limits low on shared hosting (e.g. ≤ 30/min)  
Never commit .env with live credentials

TroubleshootingIssue
What to try
Buttons do nothing
Hard refresh; check Console for SyntaxError
CSV / parse fails
Sign in first; use .csv; check Network for /api/recipients/validate
401 on API calls
Re-login; confirm cookies / edgevest_auth_token
Template looks wrong
Confirm syncVisualToHtml() and visual editor header HTML were updated
After send, old data remains
Use Clear workspace on Step 4

License & brandingBuilt for Edgevest Training & Consultancy.
Grace Land Court, Block C, J6, Opp. K.U School of Law, Parklands, Nairobi
+254 758 314 887 · trainings@edgevest.co.ke · edgevest.co.keContributingBranch from main  
Test login → recipients → template → launch → clear  
Open a PR with a clear description and screenshots if UI changed

---

# Commit message

**Short (title only):**

```text
fix(campaign): Edgevest template branding, auth-safe API calls, and workspace clear

Full (recommended):text

fix(campaign): stabilize wizard, brand email shell, and clear workspace

- Fix campaign.html script reliability (optional chaining, authenticatedFetch, insertTag)
- Harden CSV/parse validation with 401 handling and safer table row HTML
- Align email header/footer with Edgevest design (logo, gold rule, NITA footer)
- Visual editor chrome matches outbound template shell
- Add Clear workspace on Live Monitor to reset recipients, template, attachments, and stats
- Use credentials/auth helper for validate, launch, and campaign controls

Refs: recipients CSV upload, Step 2 template, post-send cleanup

Conventional alternative if you split commits:text

fix(ui): apply Edgevest invitation header/footer to campaign template
feat(campaign): add clear workspace after send
fix(auth): route campaign API calls through authenticatedFetch

