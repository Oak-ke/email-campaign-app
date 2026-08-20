import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import nodemailer from "nodemailer";
import dns from "dns";
import session from "express-session";
import cookieParser from "cookie-parser";

// Augment express-session types
declare module "express-session" {
  interface SessionData {
    smtp?: {
      host: string;
      port: number;
      username: string;
      password: string;
      from_email?: string;
      from_name?: string;
      use_tls?: boolean;
      use_ssl?: boolean;
    };
  }
}

// Force Node to prioritize IPv4 DNS lookups to avoid ENETUNREACH on IPv6 addresses
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

// Custom lookup function for Nodemailer to guarantee strictly IPv4 resolution
const forceIPv4CustomLookup = (hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};

  if (!hostname) {
    return callback(new Error("Hostname missing"));
  }

  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)) {
    if (options.all) return callback(null, [{ address: hostname, family: 4 }]);
    return callback(null, hostname, 4);
  }

  dns.lookup(hostname, { ...options, family: 4 }, (err, address, family) => {
    if (!err && address) {
      return callback(null, address, family);
    }
    dns.resolve4(hostname, (resErr, addrs) => {
      if (!resErr && addrs && addrs.length > 0) {
        if (options.all) {
          return callback(null, addrs.map(a => ({ address: a, family: 4 })));
        }
        return callback(null, addrs[0], 4);
      }
      callback(err || resErr);
    });
  });
};

// Ensure data directory and suppression list persistence
const DATA_DIR = path.join(process.cwd(), "data");
const SUPPRESSIONS_FILE = path.join(DATA_DIR, "suppressions.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSuppressions(): Array<{ email: string; date: string; reason: string }> {
  try {
    if (fs.existsSync(SUPPRESSIONS_FILE)) {
      const data = fs.readFileSync(SUPPRESSIONS_FILE, "utf-8");
      return JSON.parse(data) || [];
    }
  } catch (e) {
    console.error("Error loading suppressions:", e);
  }
  return [];
}

function saveSuppressions(suppressions: Array<{ email: string; date: string; reason: string }>) {
  try {
    fs.writeFileSync(SUPPRESSIONS_FILE, JSON.stringify(suppressions, null, 2), "utf-8");
  } catch (e) {
    console.error("Error saving suppressions:", e);
  }
}

function isEmailSuppressed(email: string): boolean {
  if (!email) return false;
  const cleanEmail = email.trim().toLowerCase();
  const suppressions = loadSuppressions();
  return suppressions.some(item => item.email.trim().toLowerCase() === cleanEmail);
}

function addSuppression(email: string, reason: string = "User unsubscribed"): boolean {
  if (!email) return false;
  const cleanEmail = email.trim().toLowerCase();
  const suppressions = loadSuppressions();
  if (suppressions.some(item => item.email.trim().toLowerCase() === cleanEmail)) {
    return true; // Already suppressed
  }
  suppressions.push({
    email: cleanEmail,
    date: new Date().toISOString(),
    reason
  });
  saveSuppressions(suppressions);
  return true;
}

// Edgevest Email Renderer (Header + Footer + Middle User Body)
function renderEdgevestEmailHTML(
  userBodyHtml: string,
  recipient: { email: string; name?: string; company?: string },
  baseUrl: string
): string {
  const cleanEmail = (recipient.email || "").trim();
  const cleanName = (recipient.name || cleanEmail.split("@")[0] || "Valued Client").trim();
  const cleanCompany = (recipient.company || "Valued Organization").trim();

  const token = Buffer.from(`${cleanEmail}:${Date.now()}`).toString("base64url");
  const unsubscribeUrl = `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(cleanEmail)}&token=${token}`;

  let bodyContent = userBodyHtml || "<p>Dear {name},</p><p>Thank you for connecting with Edgevest Training & Consultancy.</p>";
  bodyContent = bodyContent
    .replace(/\{name\}/gi, cleanName)
    .replace(/\{email\}/gi, cleanEmail)
    .replace(/\{company\}/gi, cleanCompany);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edgevest Training &amp; Consultancy</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #222222;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f6; padding: 20px 0;">
    <tr>
      <td align="center">
        <!-- Main Container -->
        <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
          
          <!-- HEADER SECTION -->
          <tr>
            <td style="background-color: #0d0b0a; padding: 28px 36px; text-align: center;">
              <a href="https://www.edgevest.co.ke" target="_blank" style="text-decoration: none; display: inline-block;">
                <img src="https://edgevest.co.ke/images/logo.png" alt="Edgevest Logo" width="180" style="width: 180px; max-width: 100%; height: auto; display: block; margin: 0 auto; border: 0;" onerror="this.onerror=null; this.src='https://raw.githubusercontent.com/Oak-ke/email-campaign-app/main/public/assets/edgevest_logo.svg';" />
              </a>
              <div style="font-size: 12px; font-weight: 700; color: #e2b871; letter-spacing: 2px; text-transform: uppercase; margin-top: 10px; font-family: Arial, sans-serif;">
                Training &amp; Consultancy
              </div>
            </td>
          </tr>

          <!-- GOLD RULE DIVIDER UNDER HEADER -->
          <tr>
            <td style="background: #c5a059; background: linear-gradient(90deg, #8c6543 0%, #e2b871 50%, #8c6543 100%); height: 3px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- USER EMAIL BODY SECTION -->
          <tr>
            <td style="padding: 32px 36px; background-color: #ffffff; color: #2d3748; font-size: 15px; line-height: 1.65;">
              ${bodyContent}
            </td>
          </tr>

          <!-- GOLD RULE DIVIDER ABOVE FOOTER -->
          <tr>
            <td style="background: #c5a059; background: linear-gradient(90deg, #8c6543 0%, #e2b871 50%, #8c6543 100%); height: 2px; font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- FOOTER SECTION -->
          <tr>
            <td style="background-color: #140f0c; padding: 32px 36px; text-align: center; color: #a8988a; font-size: 13px; line-height: 1.6;">
              <!-- Footer Logo / Emblem -->
              <div style="margin-bottom: 16px;">
                <img src="https://edgevest.co.ke/images/logo.png" alt="Edgevest Emblem" width="36" style="width: 36px; height: auto; display: inline-block; border: 0;" onerror="this.onerror=null; this.src='https://raw.githubusercontent.com/Oak-ke/email-campaign-app/main/public/assets/edgevest_emblem.jpg';" />
              </div>

              <!-- Company Name -->
              <div style="font-size: 14px; font-weight: 700; color: #ffffff; margin-bottom: 8px; letter-spacing: 0.5px;">
                Edgevest Training &amp; Consultancy
              </div>

              <!-- Address & Contact Info -->
              <div style="color: #cbd5e1; margin-bottom: 12px; font-size: 12px; line-height: 1.5;">
                Grace Land Court, Block C, J6, Opp. K.U School of Law, Parklands, Nairobi<br>
                Phone: <a href="tel:+254758314887" style="color: #e2b871; text-decoration: none;">+254 758 314 887</a> &bull; 
                Email: <a href="mailto:trainings@edgevest.co.ke" style="color: #e2b871; text-decoration: none;">trainings@edgevest.co.ke</a><br>
                Website: <a href="https://www.edgevest.co.ke" target="_blank" style="color: #e2b871; text-decoration: none;">www.edgevest.co.ke</a>
              </div>

              <!-- Accreditation / Registration -->
              <div style="font-size: 11px; color: #8c7868; padding-top: 10px; border-top: 1px solid #2e241c; margin-top: 10px;">
                NITA/TRN/2675 &nbsp;&bull;&nbsp; SR/eGP/2026/59082
              </div>

              <!-- Unsubscribe & Preferences -->
              <div style="margin-top: 16px; font-size: 12px; color: #718096;">
                You received this email because you are a registered contact of Edgevest.<br>
                <a href="${unsubscribeUrl}" target="_blank" style="color: #e2b871; text-decoration: underline; font-weight: 600;">
                  Unsubscribe from future emails
                </a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser("edgevest_cookie_secret_2026"));

  // Configure Session middleware
  app.use(
    session({
      secret: process.env.SESSION_SECRET || "edgevest_smtp_auth_session_secret_2026",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Ensures compatibility with HTTP local dev & Cloud Run proxy
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    })
  );

  // In-memory campaign state
  let currentCampaign: {
    status: string;
    total: number;
    sent: number;
    failed: number;
    skipped: number;
    currentIndex: number;
    logs: any[];
    recipients: any[];
    timer?: any;
    smtp?: any;
    template?: any;
    settings?: any;
    transporter?: nodemailer.Transporter | null;
    isProcessing?: boolean;
  } = {
    status: "idle",
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    currentIndex: 0,
    logs: [] as any[],
    recipients: [] as any[],
    timer: null,
    smtp: null,
    template: null,
    settings: null,
    transporter: null,
    isProcessing: false
  };

  // Auth Guard Middleware
  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.session && req.session.smtp && req.session.smtp.host && req.session.smtp.username) {
      return next();
    }
    return res.status(401).json({
      success: false,
      authenticated: false,
      error: "Authentication required. Please log in with valid SMTP server credentials."
    });
  };

  // Health API
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", service: "Edgevest Bulk Email Campaign Server" });
  });

  // Auth Status Check Endpoint
  app.get("/api/auth/check", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    if (req.session && req.session.smtp && req.session.smtp.host) {
      const { host, port, username, from_email, from_name, use_ssl, use_tls } = req.session.smtp;
      return res.status(200).json({
        authenticated: true,
        user: username,
        smtp: { host, port, username, from_email, from_name, use_ssl, use_tls }
      });
    }
    return res.status(200).json({ authenticated: false, smtp: null });
  });

  // SMTP Verification & Verification Helper
  async function testSmtpConnection(config: {
    host: string;
    port: number | string;
    username: string;
    password: string;
    use_ssl?: boolean;
    use_tls?: boolean;
  }) {
    const { host, port, username, password, use_ssl, use_tls } = config;
    const portNum = parseInt(String(port), 10) || 587;
    const cleanHost = (host || "").trim();
    const cleanUser = (username || "").trim();
    const isOffice365 = cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
    const isSecure = use_ssl || portNum === 465;

    const debugLogs: string[] = [];

    const customLogger = {
      level: () => "trace",
      trace: (entry: any, ...args: any[]) => {
        const msg = typeof entry === "string" ? entry : (entry?.msg || JSON.stringify(entry));
        debugLogs.push(`[TRACE] ${msg} ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`.trim());
      },
      debug: (entry: any, ...args: any[]) => {
        const msg = typeof entry === "string" ? entry : (entry?.msg || JSON.stringify(entry));
        debugLogs.push(`[DEBUG] ${msg} ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`.trim());
      },
      info: (entry: any, ...args: any[]) => {
        const msg = typeof entry === "string" ? entry : (entry?.msg || JSON.stringify(entry));
        debugLogs.push(`[INFO] ${msg} ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`.trim());
      },
      warn: (entry: any, ...args: any[]) => {
        const msg = typeof entry === "string" ? entry : (entry?.msg || JSON.stringify(entry));
        debugLogs.push(`[WARN] ${msg} ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`.trim());
      },
      error: (entry: any, ...args: any[]) => {
        const msg = typeof entry === "string" ? entry : (entry?.msg || JSON.stringify(entry));
        debugLogs.push(`[ERROR] ${msg} ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`.trim());
      }
    };

    debugLogs.push(`[INIT] Testing SMTP connection to ${cleanHost}:${portNum} for user: ${cleanUser}`);

    let resolvedIps: string[] = [];
    try {
      resolvedIps = await new Promise((resolve) => {
        dns.resolve4(cleanHost, (err, addrs) => resolve(err ? [] : addrs));
      });
      if (resolvedIps.length > 0) {
        debugLogs.push(`[DNS SUCCESS] "${cleanHost}" resolved to IPv4: [${resolvedIps.join(", ")}]`);
      }
    } catch (dnsErr: any) {
      debugLogs.push(`[DNS WARN] DNS lookup note: ${dnsErr.message}`);
    }

    const transporter = nodemailer.createTransport({
      host: cleanHost,
      port: portNum,
      secure: isSecure,
      requireTLS: portNum === 587 || use_tls || isOffice365,
      family: 4,
      lookup: forceIPv4CustomLookup,
      logger: customLogger,
      debug: true,
      auth: { user: cleanUser, pass: password },
      tls: { rejectUnauthorized: false, servername: cleanHost },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000
    } as any);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Connection Timeout: Socket connection timed out after 15000ms trying to reach ${cleanHost}:${portNum}`));
      }, 16000);
    });

    const startTime = Date.now();
    await Promise.race([transporter.verify(), timeoutPromise]);
    const elapsed = Date.now() - startTime;

    debugLogs.push(`[SUCCESS] Connection & Authentication verified in ${elapsed}ms!`);

    return { success: true, elapsed, debugLogs, resolvedIps, transporter };
  }

  // SMTP Login Endpoint
  app.post("/api/auth/smtp-login", async (req, res) => {
    const { host, port, username, password, from_email, from_name, use_ssl, use_tls } = req.body || {};

    if (!host || !host.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Hostname is required (e.g. outlook.office365.com)." });
    }
    if (!port) {
      return res.status(400).json({ success: false, error: "SMTP Port is required (e.g. 587 or 465)." });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Username / Email is required." });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Password is required for authentication." });
    }

    try {
      const result = await testSmtpConnection({ host, port, username, password, use_ssl, use_tls });

      if (result.success) {
        req.session.smtp = {
          host: host.trim(),
          port: parseInt(port, 10) || 587,
          username: username.trim(),
          password: password,
          from_email: (from_email || username).trim(),
          from_name: (from_name || "Edgevest Team").trim(),
          use_ssl: !!use_ssl,
          use_tls: !!use_tls
        };

        return req.session.save((err) => {
          if (err) {
            return res.status(500).json({ success: false, error: "Failed to save session state." });
          }
          return res.json({
            success: true,
            authenticated: true,
            message: `SMTP Login Successful! Verified connection to ${host}:${port} as ${username}.`,
            user: username.trim()
          });
        });
      }
    } catch (err: any) {
      let rawErrorMsg = err.message || String(err);
      const lowerErr = rawErrorMsg.toLowerCase();
      const errCode = (err.code || "").toUpperCase();

      let friendlyError = "";
      let errorType = "GENERAL_ERROR";

      if (
        rawErrorMsg.includes("535") ||
        rawErrorMsg.includes("534") ||
        rawErrorMsg.includes("530") ||
        errCode === "EAUTH" ||
        lowerErr.includes("authentication failed") ||
        lowerErr.includes("invalid credentials")
      ) {
        errorType = "AUTH_FAILED";
        friendlyError = `Authentication Failed for ${username} on ${host}:${port}.\n\n` +
          `🔑 Failure Details: The SMTP server was reached, but rejected the username or password.\n\n` +
          `💡 Troubleshooting:\n` +
          `1. Double-check password accuracy for ${username}.\n` +
          `2. For Microsoft 365: Ensure 'Authenticated SMTP' is enabled in M365 Admin Center.\n` +
          `3. If 2FA is active, generate and use an App Password.`;
      } else if (
        errCode === "ETIMEDOUT" ||
        errCode === "ECONNREFUSED" ||
        lowerErr.includes("timeout") ||
        lowerErr.includes("enetunreach")
      ) {
        errorType = "CONNECTION_TIMEOUT";
        friendlyError = `Connection Timeout to ${host}:${port}.\n\n` +
          `⏱️ Failure Details: Could not reach SMTP server within 15 seconds.\n\n` +
          `💡 Troubleshooting:\n` +
          `1. Check Host and Port settings (Port 587 with STARTTLS or Port 465 with Direct SSL).\n` +
          `2. Ensure firewall or cloud provider does not block outbound SMTP ports.`;
      } else {
        friendlyError = `SMTP Error: ${rawErrorMsg}`;
      }

      return res.status(400).json({
        success: false,
        authenticated: false,
        error: friendlyError,
        error_type: errorType
      });
    }
  });

  // Logout Endpoint
  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    if (req.session) {
      delete req.session.smtp;
      req.session.destroy((err) => {
        res.clearCookie("connect.sid", { path: "/" });
        return res.json({ success: true, message: "Logged out successfully." });
      });
    } else {
      res.clearCookie("connect.sid", { path: "/" });
      return res.json({ success: true, message: "Logged out successfully." });
    }
  });

  // Verify SMTP Endpoint (Public / Pre-Check or Settings update)
  app.post("/api/smtp/verify", async (req, res) => {
    const { host, port, username, password, use_ssl, use_tls } = req.body || {};
    if (!host || !port || !username || !password) {
      return res.status(400).json({ success: false, error: "Missing required SMTP parameters." });
    }

    try {
      const result = await testSmtpConnection({ host, port, username, password, use_ssl, use_tls });
      return res.json({
        success: true,
        message: `SMTP Connection & Auth Verified for ${host}:${port}`,
        logs: result.debugLogs
      });
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: err.message || "SMTP Verification Failed."
      });
    }
  });

  // Unsubscribe Endpoints
  app.get("/api/unsubscribe", (req, res) => {
    const email = (req.query.email as string || "").trim();
    if (email) {
      addSuppression(email, "Unsubscribed via email link");
    }
    // Redirect to clean Unsubscribe confirmation page
    return res.redirect(`/unsubscribe.html?email=${encodeURIComponent(email)}&status=success`);
  });

  app.post("/api/unsubscribe", (req, res) => {
    const { email, reason } = req.body || {};
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, error: "Email address is required." });
    }
    addSuppression(email, reason || "User unsubscribed via API");
    return res.json({
      success: true,
      message: `Email ${email} has been added to the suppression list.`
    });
  });

  app.get("/api/suppressions", requireAuth, (req, res) => {
    const suppressions = loadSuppressions();
    return res.json({
      success: true,
      count: suppressions.length,
      suppressions
    });
  });

  // Recipients Validation Endpoint
  app.post("/api/recipients/validate", requireAuth, (req, res) => {
    const raw = req.body?.recipients || [];
    const valid: any[] = [];
    const invalid: any[] = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    raw.forEach((r: any) => {
      const email = typeof r === "string" ? r.trim() : (r.email || "").trim();
      const name = typeof r === "string" ? r.split("@")[0] : (r.name || email.split("@")[0]);
      const company = r.company || "Valued Client";

      if (email && emailRegex.test(email)) {
        const suppressed = isEmailSuppressed(email);
        valid.push({ email, name, company, status: suppressed ? "suppressed" : "valid", is_suppressed: suppressed });
      } else if (email) {
        invalid.push({ email, name, error: "Invalid email syntax" });
      }
    });

    res.json({
      total_submitted: raw.length,
      valid_count: valid.length,
      invalid_count: invalid.length,
      valid_recipients: valid,
      invalid_recipients: invalid
    });
  });

  // Start Campaign Endpoint (Protected, uses session SMTP as source of truth)
  app.post("/api/campaign/start", requireAuth, async (req, res) => {
    const { recipients, template, settings } = req.body || {};
    const smtp = req.session.smtp;

    if (!smtp || !smtp.host || !smtp.username) {
      return res.status(401).json({ success: false, error: "SMTP Session expired. Please log in again." });
    }

    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ success: false, error: "No campaign recipients provided." });
    }

    if (currentCampaign.timer) clearInterval(currentCampaign.timer);

    const attachments = template?.attachments || [];
    const attNames = attachments.map((a: any) => a.name).join(", ");
    const initLogs: any[] = [
      { time: new Date().toLocaleTimeString(), message: `Campaign initialized for ${recipients.length} recipients.`, level: "info" },
      { time: new Date().toLocaleTimeString(), message: `[SMTP ENGINE] Configured with server: ${smtp.host}:${smtp.port} (${smtp.from_email || smtp.username})`, level: "info" }
    ];

    if (attachments.length > 0) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign includes ${attachments.length} attachment(s): ${attNames}`,
        level: "info"
      });
    }

    let transporter: nodemailer.Transporter | null = null;
    try {
      const portNum = parseInt(String(smtp.port), 10) || 587;
      const cleanHost = smtp.host.trim();
      const cleanUser = smtp.username.trim();
      const isOffice365 = cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
      const isSecure = smtp.use_ssl || portNum === 465;

      transporter = nodemailer.createTransport({
        host: cleanHost,
        port: portNum,
        secure: isSecure,
        requireTLS: portNum === 587 || smtp.use_tls || isOffice365,
        family: 4,
        lookup: forceIPv4CustomLookup,
        auth: { user: cleanUser, pass: smtp.password },
        tls: { rejectUnauthorized: false, servername: cleanHost },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000
      } as any);
    } catch (e: any) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `Transporter Initialization Error: ${e.message}`,
        level: "error"
      });
    }

    currentCampaign = {
      status: "running",
      total: recipients.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      currentIndex: 0,
      logs: initLogs,
      recipients: recipients.map((r: any) => ({ ...r, status: "pending" })),
      smtp,
      template,
      settings,
      transporter,
      isProcessing: false
    };

    runCampaignQueue(req);

    res.json({ success: true, message: "Campaign started successfully.", total: recipients.length });
  });

  async function runCampaignQueue(req?: express.Request) {
    if (currentCampaign.isProcessing) return;
    currentCampaign.isProcessing = true;

    const { smtp, template, settings, transporter } = currentCampaign;
    const speed = Math.max(parseInt(settings?.max_per_minute || "30"), 1);
    const intervalMs = Math.max(Math.floor(60000 / speed), 300);
    const attachments = template?.attachments || [];
    const fromEmail = (smtp?.from_email || smtp?.username || "trainings@edgevest.co.ke").trim();
    const fromName = (smtp?.from_name || "Edgevest Team").trim();

    const protocol = req?.protocol || "http";
    const host = req?.get("host") || `localhost:${PORT}`;
    const baseUrl = `${protocol}://${host}`;

    while (
      currentCampaign.status === "running" &&
      currentCampaign.currentIndex < currentCampaign.total
    ) {
      const idx = currentCampaign.currentIndex;
      const rec = currentCampaign.recipients[idx];
      const displayIndex = idx + 1;

      // Check if recipient is on the Suppression List!
      if (isEmailSuppressed(rec.email)) {
        currentCampaign.skipped++;
        currentCampaign.recipients[idx].status = "skipped";
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[SKIPPED] Recipient ${rec.email} is on the suppression list (unsubscribed).`,
          level: "warning"
        });
        currentCampaign.currentIndex++;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // Render standardized Edgevest HTML email with header, footer & unsubscribe token link
      const emailHtml = renderEdgevestEmailHTML(
        template?.body_html || "",
        rec,
        baseUrl
      );

      // Personalize Subject Line
      let personalizedSubject = (template?.subject || "Edgevest Update")
        .replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
        .replace(/\{email\}/gi, rec.email)
        .replace(/\{company\}/gi, rec.company || "Valued Client");

      if (transporter) {
        try {
          const userAttachments = attachments.map((att: any) => {
            let filename = att.name || "attachment.pdf";
            filename = filename
              .replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
              .replace(/\{email\}/gi, rec.email)
              .replace(/\{company\}/gi, rec.company || "Valued Client");

            let contentStr = att.data || "";
            if (typeof contentStr === "string" && contentStr.includes(";base64,")) {
              contentStr = contentStr.split(";base64,")[1];
            }
            return {
              filename: filename,
              content: Buffer.from(contentStr, "base64")
            };
          });

          const info = await transporter.sendMail({
            from: `"${fromName}" <${fromEmail}>`,
            to: rec.email,
            subject: personalizedSubject,
            html: emailHtml,
            attachments: userAttachments
          });

          currentCampaign.sent++;
          currentCampaign.recipients[idx].status = "sent";
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[SUCCESS ${displayIndex}/${currentCampaign.total}] Dispatched to ${rec.email} (MessageID: ${info.messageId})`,
            level: "success"
          });
        } catch (sendErr: any) {
          currentCampaign.failed++;
          currentCampaign.recipients[idx].status = "failed";
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[FAILED ${displayIndex}/${currentCampaign.total}] Delivery to ${rec.email} failed: ${sendErr.message}`,
            level: "error"
          });
        }
      } else {
        // Simulation mode
        currentCampaign.sent++;
        currentCampaign.recipients[idx].status = "sent";
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[SIMULATION ${displayIndex}/${currentCampaign.total}] Simulated send to ${rec.email}`,
          level: "info"
        });
      }

      currentCampaign.currentIndex++;

      if (currentCampaign.currentIndex < currentCampaign.total && currentCampaign.status === "running") {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    if (currentCampaign.currentIndex >= currentCampaign.total && currentCampaign.status === "running") {
      currentCampaign.status = "completed";
      currentCampaign.logs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign Finished! Total: ${currentCampaign.total} | Sent: ${currentCampaign.sent} | Skipped: ${currentCampaign.skipped} | Failed: ${currentCampaign.failed}`,
        level: "info"
      });
    }

    currentCampaign.isProcessing = false;
  }

  // Control Endpoints
  app.post("/api/campaign/pause", requireAuth, (req, res) => {
    if (currentCampaign.status === "running") {
      currentCampaign.status = "paused";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign paused by operator.", level: "warning" });
    }
    res.json({ success: true, status: currentCampaign.status });
  });

  app.post("/api/campaign/resume", requireAuth, (req, res) => {
    if (currentCampaign.status === "paused") {
      currentCampaign.status = "running";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign resumed by operator.", level: "info" });
      runCampaignQueue(req);
    }
    res.json({ success: true, status: currentCampaign.status });
  });

  app.post("/api/campaign/cancel", requireAuth, (req, res) => {
    currentCampaign.status = "cancelled";
    currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign cancelled.", level: "warning" });
    res.json({ success: true, message: "Campaign cancelled." });
  });

  // Log Management API Endpoints
  app.post("/api/campaign/log/add", requireAuth, (req, res) => {
    const { message, level, note } = req.body || {};
    if (!message) return res.status(400).json({ success: false, error: "Message required." });
    const logItem = {
      id: "log_" + Date.now() + "_" + Math.random().toString(36).substring(2, 5),
      time: new Date().toLocaleTimeString(),
      message,
      level: level || "info",
      note: note || ""
    };
    currentCampaign.logs.push(logItem);
    res.json({ success: true, log: logItem });
  });

  app.post("/api/campaign/log/edit", requireAuth, (req, res) => {
    const { index, message, note, level } = req.body || {};
    if (index === undefined || index < 0 || index >= currentCampaign.logs.length) {
      return res.status(400).json({ success: false, error: "Invalid log index." });
    }
    if (message !== undefined) currentCampaign.logs[index].message = message;
    if (note !== undefined) currentCampaign.logs[index].note = note;
    if (level !== undefined) currentCampaign.logs[index].level = level;
    res.json({ success: true, updated: currentCampaign.logs[index] });
  });

  app.post("/api/campaign/log/delete", requireAuth, (req, res) => {
    const { index } = req.body || {};
    if (index === undefined || index < 0 || index >= currentCampaign.logs.length) {
      return res.status(400).json({ success: false, error: "Invalid log index." });
    }
    const removed = currentCampaign.logs.splice(index, 1);
    res.json({ success: true, removed });
  });

  app.post("/api/campaign/log/clear", requireAuth, (req, res) => {
    currentCampaign.logs = [{ time: new Date().toLocaleTimeString(), message: "Log console cleared by operator.", level: "info" }];
    res.json({ success: true, message: "Logs cleared." });
  });

  app.get("/api/campaign/logs/export", requireAuth, (req, res) => {
    const format = req.query.format || "txt";
    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", 'attachment; filename="edgevest_campaign_logs.json"');
      return res.send(JSON.stringify(currentCampaign.logs, null, 2));
    }

    let textOutput = `========================================================\n`;
    textOutput += `EDGEVEST EMAIL CAMPAIGN MANAGER - EXECUTION LOG REPORT\n`;
    textOutput += `Generated: ${new Date().toLocaleString()}\n`;
    textOutput += `Status: ${currentCampaign.status.toUpperCase()} | Sent: ${currentCampaign.sent} | Skipped: ${currentCampaign.skipped} | Failed: ${currentCampaign.failed} | Total: ${currentCampaign.total}\n`;
    textOutput += `========================================================\n\n`;

    currentCampaign.logs.forEach((log: any, idx: number) => {
      textOutput += `[${idx + 1}] [${log.time}] [${(log.level || "INFO").toUpperCase()}] ${log.message}`;
      if (log.note) textOutput += ` (Note: ${log.note})`;
      textOutput += `\n`;
    });

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", 'attachment; filename="edgevest_campaign_logs.log"');
    res.send(textOutput);
  });

  app.get("/api/campaign/status", requireAuth, (req, res) => {
    const progress_percent = currentCampaign.total > 0
      ? Math.round((currentCampaign.currentIndex / currentCampaign.total) * 100)
      : 0;

    res.json({
      status: currentCampaign.status,
      total: currentCampaign.total,
      sent: currentCampaign.sent,
      skipped: currentCampaign.skipped,
      failed: currentCampaign.failed,
      current_index: currentCampaign.currentIndex,
      progress_percent,
      logs: currentCampaign.logs.slice(-50),
      recipients_summary: currentCampaign.recipients
    });
  });

  app.get("/api/campaign/stream", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendUpdate = () => {
      const progress_percent = currentCampaign.total > 0
        ? Math.round((currentCampaign.currentIndex / currentCampaign.total) * 100)
        : 0;
      const payload = {
        type: "progress",
        data: {
          status: currentCampaign.status,
          total: currentCampaign.total,
          sent: currentCampaign.sent,
          skipped: currentCampaign.skipped,
          failed: currentCampaign.failed,
          current_index: currentCampaign.currentIndex,
          progress_percent,
          logs: currentCampaign.logs
        }
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (
        currentCampaign.status === "completed" ||
        currentCampaign.status === "cancelled" ||
        currentCampaign.status === "failed" ||
        (currentCampaign.total > 0 && currentCampaign.currentIndex >= currentCampaign.total && currentCampaign.status !== "running")
      ) {
        clearInterval(interval);
        res.end();
      }
    };

    const interval = setInterval(sendUpdate, 1000);
    sendUpdate();

    req.on("close", () => {
      clearInterval(interval);
    });
  });

  app.get("/api/download-file/:filename", (req, res) => {
    const fn = req.params.filename;
    const allowed = ["app.py", "config.py", "passenger_wsgi.py", "requirements.txt", ".env.example", "public/campaign.html", "public/index.html", "public/login.html"];
    if (!allowed.includes(fn)) {
      return res.status(400).send("Invalid file.");
    }
    const targetFn = fn === "public/index.html" ? "public/campaign.html" : fn;
    const filePath = path.join(process.cwd(), targetFn);
    if (fs.existsSync(filePath)) {
      res.download(filePath);
    } else {
      res.status(404).send("File not found.");
    }
  });

  // Serve static assets explicitly
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use("/public", express.static(path.join(process.cwd(), "public")));
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));
  app.use("/assets", express.static(path.join(process.cwd(), "public", "assets")));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Campaign App running on http://localhost:${PORT}`);
  });
}

startServer();
