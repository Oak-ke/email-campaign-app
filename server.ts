import express from "express";
import path from "path";
import rateLimit from "express-rate-limit";
import * as lockfile from "proper-lockfile";
import fs from "fs";
import crypto from "crypto";
import nodemailer from "nodemailer";
import dns from "dns";
import session from "express-session";
import cookieParser from "cookie-parser";
import FileStore from "session-file-store";

/** Normalize fancy punctuation that breaks strict mail servers */
function sanitizeEmailText(s: string): string {
  return String(s || "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\uFEFF/g, "");
}

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

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const forceIPv4CustomLookup = (hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  if (!hostname) return callback(new Error("Hostname missing"));
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)) {
    if (options.all) return callback(null, [{ address: hostname, family: 4 }]);
    return callback(null, hostname, 4);
  }
  dns.lookup(hostname, { ...options, family: 4 }, (err, address, family) => {
    if (!err && address) return callback(null, address, family);
    dns.resolve4(hostname, (resErr, addrs) => {
      if (!resErr && addrs && addrs.length > 0) {
        if (options.all) return callback(null, addrs.map((a) => ({ address: a, family: 4 })));
        return callback(null, addrs[0], 4);
      }
      callback(err || resErr);
    });
  });
};

const DATA_DIR = path.join(process.cwd(), "data");
const SUPPRESSIONS_FILE = path.join(DATA_DIR, "suppressions.json");
const UNSUBSCRIBE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSuppressions(): Array<{ email: string; date: string; reason: string }> {
  try {
    if (fs.existsSync(SUPPRESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SUPPRESSIONS_FILE, "utf-8")) || [];
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
  return loadSuppressions().some((item) => item.email.trim().toLowerCase() === cleanEmail);
}

function getUnsubscribeSecret(): string {
  return (
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.SESSION_SECRET ||
    "edgevest_smtp_auth_session_secret_2026"
  );
}

function createUnsubscribeToken(email: string, issuedAtMs: number = Date.now()): string {
  const clean = (email || "").trim().toLowerCase();
  const payload = `${clean}|${issuedAtMs}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", getUnsubscribeSecret()).update(payload).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyUnsubscribeToken(
  email: string,
  token: string
): { valid: boolean; isExpired?: boolean; reason?: string } {
  try {
    const cleanEmail = (email || "").trim().toLowerCase();
    const raw = (token || "").trim();
    if (!cleanEmail || !raw) return { valid: false, reason: "missing" };

    if (raw.includes(".")) {
      const [payloadB64, sig] = raw.split(".");
      if (!payloadB64 || !sig) return { valid: false, reason: "malformed" };
      const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
      const expectedSig = crypto
        .createHmac("sha256", getUnsubscribeSecret())
        .update(payload)
        .digest("base64url");
      if (!timingSafeEqualStr(sig, expectedSig)) return { valid: false, reason: "bad_signature" };
      const [tokenEmail, tsStr] = payload.split("|");
      if (!tokenEmail || tokenEmail !== cleanEmail) return { valid: false, reason: "email_mismatch" };
      const issuedAt = parseInt(tsStr, 10);
      if (!Number.isFinite(issuedAt)) return { valid: false, reason: "bad_ts" };
      if (Date.now() - issuedAt > UNSUBSCRIBE_TOKEN_TTL_MS) return { valid: false, isExpired: true };
      if (issuedAt > Date.now() + 60_000) return { valid: false, reason: "future_ts" };
      return { valid: true };
    }

    if (process.env.ALLOW_LEGACY_UNSUB_TOKENS === "true") {
      const decoded = Buffer.from(raw, "base64url").toString("utf8");
      const [tokenEmail, tsStr] = decoded.split(":");
      if (tokenEmail !== cleanEmail) return { valid: false };
      const age = Date.now() - parseInt(tsStr, 10);
      if (age > UNSUBSCRIBE_TOKEN_TTL_MS) return { valid: false, isExpired: true };
      return { valid: true };
    }

    return { valid: false, reason: "unsupported_format" };
  } catch {
    return { valid: false, reason: "error" };
  }
}

async function addSuppression(email: string, reason: string = "User unsubscribed"): Promise<boolean> {
  if (!email) return false;
  const cleanEmail = email.trim().toLowerCase();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SUPPRESSIONS_FILE)) fs.writeFileSync(SUPPRESSIONS_FILE, "[]", "utf-8");

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(SUPPRESSIONS_FILE, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    });
    const suppressions = loadSuppressions();
    if (suppressions.some((item) => item.email.trim().toLowerCase() === cleanEmail)) return true;
    suppressions.push({ email: cleanEmail, date: new Date().toISOString(), reason });
    saveSuppressions(suppressions);
    return true;
  } catch (e) {
    console.error("addSuppression error:", e);
    const suppressions = loadSuppressions();
    if (!suppressions.some((item) => item.email.trim().toLowerCase() === cleanEmail)) {
      suppressions.push({ email: cleanEmail, date: new Date().toISOString(), reason });
      saveSuppressions(suppressions);
    }
    return true;
  } finally {
    if (release) {
      try {
        await release();
      } catch (_) {}
    }
  }
}

const LOGS_DIR = path.join(DATA_DIR, "campaign-logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function appendCampaignLog(entry: any) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(LOGS_DIR, `campaign-${date}.log`);
    const line = `[${entry.time || new Date().toLocaleTimeString()}] [${(entry.level || "info").toUpperCase()}] ${entry.message}\n`;
    fs.appendFileSync(file, line, "utf-8");
  } catch (e) {
    console.error("Failed to write campaign log:", e);
  }
}

const unsubscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many unsubscribe requests, please try again later.",
});

function renderEdgevestEmailHTML(
  userBodyHtml: string,
  recipient: { email: string; name?: string; company?: string },
  baseUrl: string
): string {
  const cleanEmail = (recipient.email || "").trim();
  const cleanName = sanitizeEmailText(
    (recipient.name || cleanEmail.split("@")[0] || "Valued Client").trim()
  );
  const cleanCompany = sanitizeEmailText((recipient.company || "Valued Organization").trim());

  const token = createUnsubscribeToken(cleanEmail);
  const unsubscribeUrl = `${baseUrl.replace(/\/+$/, "")}/api/unsubscribe?email=${encodeURIComponent(cleanEmail)}&token=${encodeURIComponent(token)}`;

  let bodyContent =
    userBodyHtml ||
    "<p style='margin-bottom: 16px;'>Dear {name},</p><p style='margin-bottom: 16px;'>We are excited to invite you to our upcoming professional training session with Edgevest Training & Consultancy.</p>";
  bodyContent = bodyContent
    .replace(/\{name\}/gi, cleanName)
    .replace(/\{email\}/gi, cleanEmail)
    .replace(/\{company\}/gi, cleanCompany);
  bodyContent = sanitizeEmailText(bodyContent);

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Edgevest Training &amp; Consultancy</title>
  <style type="text/css">
    body { margin: 0; padding: 0; min-width: 100%; background-color: #f5f3f0; font-family: Georgia, 'Times New Roman', serif; }
    table { border-collapse: collapse; }
    a { color: #c5a059; text-decoration: underline; }
  </style>
</head>
<body bgcolor="#f5f3f0" style="margin: 0; padding: 20px 0; background-color: #f5f3f0; font-family: Georgia, 'Times New Roman', serif;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f5f3f0" style="background-color: #f5f3f0; width: 100%;">
    <tr>
      <td align="center" style="padding: 10px;">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border: 1px solid #e8e3dc; border-radius: 8px; margin: 0 auto;" align="center" bgcolor="#ffffff">
          <tr>
            <td align="left" bgcolor="#ffffff" style="padding: 20px 24px; border-bottom: 3px solid #c5a059;">
              <h1 style="font-family: Georgia, serif; font-size: 24px; margin: 0; color: #4a3a2a;">Edgevest</h1>
              <p style="font-size: 14px; margin: 4px 0 0; color: #6b5a4a;">Professional Training and Development</p>
            </td>
          </tr>
          <tr>
            <td align="left" bgcolor="#ffffff" style="padding: 32px 28px; font-size: 15px; color: #1a1a1a; line-height: 1.65;">
              <div>${bodyContent}</div>
            </td>
          </tr>
          <tr>
            <td align="center" bgcolor="#ffffff" style="padding: 24px; border-top: 3px solid #c5a059; color: #4a3a2a;">
              <div style="font-size: 16px; font-weight: bold; margin-bottom: 6px;">Edgevest Training &amp; Consultancy</div>
              <div style="font-size: 13px; color: #6b5a4a; margin-bottom: 10px; line-height: 1.5;">
                Grace Land Court, Block C, J6, Opp. K.U School of Law, Parklands, Nairobi<br/>
                Phone: <a href="tel:+254758314887" style="color: #c5a059; text-decoration: none;">+254 758 314 887</a> &bull;
                Email: <a href="mailto:trainings@edgevest.co.ke" style="color: #c5a059; text-decoration: none;">trainings@edgevest.co.ke</a>
              </div>
              <div style="font-size: 11px; color: #9a8a7a; padding-top: 8px; border-top: 1px solid #e8e3dc;">NITA/TRN/2675 &bull; SR/eGP/2026/59082</div>
              <div style="margin-top: 14px; font-size: 12px;">
                <a href="${unsubscribeUrl}" target="_blank" style="color: #c5a059; text-decoration: underline; font-weight: bold;">Unsubscribe from future emails</a>
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
  app.set("trust proxy", true);
  const PORT = Number(process.env.PORT) || 3000;

  console.log(`[STARTUP] Working directory: ${process.cwd()}`);
  console.log(`[STARTUP] Data directory: ${DATA_DIR}`);

  function getBaseUrl(req?: express.Request): string {
    if (req) {
      const origin = req.headers.origin;
      if (origin && typeof origin === "string" && !origin.includes("localhost") && !origin.includes("127.0.0.1")) {
        return origin.replace(/\/+$/, "");
      }
      const referer = req.headers.referer;
      if (referer && typeof referer === "string") {
        try {
          const parsed = new URL(referer);
          if (parsed.origin && !parsed.origin.includes("localhost") && !parsed.origin.includes("127.0.0.1")) {
            return parsed.origin.replace(/\/+$/, "");
          }
        } catch (e) {}
      }
      const rawForwardedHost = req.headers["x-forwarded-host"];
      const forwardedHost = Array.isArray(rawForwardedHost) ? rawForwardedHost[0] : rawForwardedHost;
      if (forwardedHost && typeof forwardedHost === "string" && !forwardedHost.includes("localhost")) {
        const rawForwardedProto = req.headers["x-forwarded-proto"];
        const proto = (Array.isArray(rawForwardedProto) ? rawForwardedProto[0] : rawForwardedProto) || "https";
        return `${proto}://${forwardedHost}`.replace(/\/+$/, "");
      }
      const host = req.get("host");
      if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
        return `${req.protocol || "https"}://${host}`.replace(/\/+$/, "");
      }
    }
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
    return `http://localhost:${process.env.PORT || 3000}`;
  }

  function createSmtpTransporter(smtp: any): nodemailer.Transporter {
    const portNum = parseInt(String(smtp.port), 10) || 587;
    const cleanHost = (smtp.host || "").trim();

    return nodemailer.createTransport({
      host: cleanHost,
      port: portNum,
      secure: !!smtp.use_ssl || portNum === 465,
      requireTLS: !!smtp.use_tls && portNum !== 465,
      family: 4,
      lookup: forceIPv4CustomLookup,
      auth: {
        user: (smtp.username || "").trim(),
        pass: smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
        servername: cleanHost,
      },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
      pool: true,
      maxConnections: 1,
      maxMessages: 300,
      rateDelta: 1000,
      rateLimit: 20,
    } as any);
  }

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser("edgevest_cookie_secret_2026"));

  const FileStoreSession = FileStore(session);
  const sessionStorePath = path.join(process.cwd(), "sessions");
  app.use(
    session({
      store: new FileStoreSession({ path: sessionStorePath }),
      secret: process.env.SESSION_SECRET || "edgevest_smtp_auth_session_secret_2026",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    })
  );

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
    baseUrl?: string;
  } = {
    status: "idle",
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    currentIndex: 0,
    logs: [],
    recipients: [],
    timer: null,
    smtp: null,
    template: null,
    settings: null,
    transporter: null,
    isProcessing: false,
    baseUrl: "",
  };

  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
    if (currentCampaign) {
      const logEntry = {
        time: new Date().toLocaleTimeString(),
        message: `[UNCAUGHT EXCEPTION] ${err.message}`,
        level: "error",
      };
      currentCampaign.logs.push(logEntry);
      appendCampaignLog(logEntry);
      saveCampaignState();
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
    if (currentCampaign) {
      const logEntry = {
        time: new Date().toLocaleTimeString(),
        message: `[UNHANDLED REJECTION] ${reason}`,
        level: "error",
      };
      currentCampaign.logs.push(logEntry);
      appendCampaignLog(logEntry);
      saveCampaignState();
    }
  });

  const CAMPAIGN_STATE_FILE = path.join(DATA_DIR, "campaign-state.json");

  function saveCampaignState() {
    try {
      const snapshot = {
        status: currentCampaign.status,
        total: currentCampaign.total,
        sent: currentCampaign.sent,
        failed: currentCampaign.failed,
        skipped: currentCampaign.skipped,
        currentIndex: currentCampaign.currentIndex,
        logs: currentCampaign.logs.slice(-500),
        recipients: currentCampaign.recipients,
        settings: currentCampaign.settings,
        template: currentCampaign.template
          ? {
              subject: currentCampaign.template.subject,
              body_html: currentCampaign.template.body_html,
            }
          : null,
        smtp: currentCampaign.smtp
          ? {
              host: currentCampaign.smtp.host,
              port: currentCampaign.smtp.port,
              username: currentCampaign.smtp.username,
              from_email: currentCampaign.smtp.from_email,
              from_name: currentCampaign.smtp.from_name,
              use_ssl: currentCampaign.smtp.use_ssl,
              use_tls: currentCampaign.smtp.use_tls,
              password: currentCampaign.smtp.password,
            }
          : null,
        updatedAt: new Date().toISOString(),
      };
      const tmpFile = CAMPAIGN_STATE_FILE + ".tmp";
      fs.writeFileSync(tmpFile, JSON.stringify(snapshot), "utf-8");
      fs.renameSync(tmpFile, CAMPAIGN_STATE_FILE);
    } catch (e) {
      console.error("saveCampaignState failed:", e);
    }
  }

  function loadCampaignState() {
    try {
      if (!fs.existsSync(CAMPAIGN_STATE_FILE)) return null;
      return JSON.parse(fs.readFileSync(CAMPAIGN_STATE_FILE, "utf-8"));
    } catch (e) {
      console.error("loadCampaignState failed:", e);
      return null;
    }
  }

  // --- State Restoration & Auto-Resume ---
  const saved = loadCampaignState();
  if (saved && (saved.status === "running" || saved.status === "paused")) {
    console.log(`[STARTUP] Restoring campaign in status "${saved.status}" with ${saved.currentIndex}/${saved.total} emails sent.`);
    let restoredTransporter = null;
    if (saved.smtp) {
      try {
        restoredTransporter = createSmtpTransporter(saved.smtp);
      } catch (e) {
        console.error("Failed to create transporter during restore:", e);
      }
    }
    currentCampaign = {
      ...currentCampaign,
      ...saved,
      transporter: restoredTransporter,
      isProcessing: false,
      baseUrl: process.env.APP_URL || `http://localhost:${PORT}`,
    };

    if (currentCampaign.status === "running") {
      console.log("[STARTUP] Auto-resuming campaign queue...");
      runCampaignQueue();
    }
  } else {
    console.log("[STARTUP] No saved campaign to restore. Initializing idle state.");
    saveCampaignState();
  }

  const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.session?.smtp?.host && req.session?.smtp?.username) return next();
    return res.status(401).json({
      success: false,
      authenticated: false,
      error: "Authentication required. Please log in with valid SMTP server credentials.",
    });
  };

  async function processUnsubscribe(email: string, token: string, reason: string) {
    if (!email || !token) {
      return { ok: false as const, status: 400, message: "Missing email or token." };
    }
    const verification = verifyUnsubscribeToken(email, token);
    if (!verification.valid) {
      return {
        ok: false as const,
        status: 400,
        message: verification.isExpired
          ? "This unsubscribe link has expired. Please contact support to be removed."
          : "Invalid unsubscribe link.",
      };
    }
    if (isEmailSuppressed(email)) {
      return { ok: true as const, status: 200, message: "Already unsubscribed.", already: true };
    }
    await addSuppression(email, reason);
    return { ok: true as const, status: 200, message: "Unsubscribed successfully.", already: false };
  }

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
    const isOffice365 =
      cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
    const isSecure = use_ssl || portNum === 465;
    const debugLogs: string[] = [];

    const customLogger = {
      level: () => "trace",
      trace: (entry: any) => debugLogs.push(`[TRACE] ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
      debug: (entry: any) => debugLogs.push(`[DEBUG] ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
      info: (entry: any) => debugLogs.push(`[INFO] ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
      warn: (entry: any) => debugLogs.push(`[WARN] ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
      error: (entry: any) => debugLogs.push(`[ERROR] ${typeof entry === "string" ? entry : JSON.stringify(entry)}`),
    };

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
      socketTimeout: 15000,
    } as any);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Connection Timeout after 15000ms to ${cleanHost}:${portNum}`)), 16000);
    });

    const startTime = Date.now();
    await Promise.race([transporter.verify(), timeoutPromise]);
    return { success: true, elapsed: Date.now() - startTime, debugLogs, transporter };
  }

  // --- API Routes ---
  app.get("/api/health", (_req, res) => {
    res.json({ status: "online", service: "Edgevest Bulk Email Campaign Server" });
  });

  app.get("/api/auth/check", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    if (req.session?.smtp?.host) {
      const { host, port, username, from_email, from_name, use_ssl, use_tls } = req.session.smtp;
      return res.status(200).json({
        authenticated: true,
        user: username,
        smtp: { host, port, username, from_email, from_name, use_ssl, use_tls },
      });
    }
    return res.status(200).json({ authenticated: false, smtp: null });
  });

  app.post("/api/auth/smtp-login", async (req, res) => {
    const { host, port, username, password, from_email, from_name, use_ssl, use_tls } = req.body || {};
    if (!host?.trim()) return res.status(400).json({ success: false, error: "SMTP Hostname is required." });
    if (!port) return res.status(400).json({ success: false, error: "SMTP Port is required." });
    if (!username?.trim()) return res.status(400).json({ success: false, error: "SMTP Username is required." });
    if (!password?.trim()) return res.status(400).json({ success: false, error: "SMTP Password is required." });

    try {
      const result = await testSmtpConnection({ host, port, username, password, use_ssl, use_tls });
      if (result.success) {
        req.session.smtp = {
          host: host.trim(),
          port: parseInt(String(port), 10) || 587,
          username: username.trim(),
          password,
          from_email: (from_email || username).trim(),
          from_name: (from_name || "Edgevest Team").trim(),
          use_ssl: !!use_ssl,
          use_tls: !!use_tls,
        };
        return req.session.save((err) => {
          if (err) return res.status(500).json({ success: false, error: "Failed to save session." });
          return res.json({
            success: true,
            authenticated: true,
            message: "SMTP Login Successful!",
            user: username.trim(),
          });
        });
      }
    } catch (err: any) {
      return res.status(400).json({ success: false, authenticated: false, error: err.message || "SMTP Error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.session) {
      delete req.session.smtp;
      req.session.destroy(() => {
        res.clearCookie("connect.sid", { path: "/" });
        return res.json({ success: true, message: "Logged out successfully." });
      });
    } else {
      res.clearCookie("connect.sid", { path: "/" });
      return res.json({ success: true, message: "Logged out successfully." });
    }
  });

  app.get("/api/unsubscribe", unsubscribeLimiter, async (req, res) => {
    const q = req.query || {};
    const email = String(q.email || "").trim().toLowerCase();
    const token = String(q.token || "").trim();
    const result = await processUnsubscribe(email, token, "Unsubscribed via email link");
    if (!result.ok) return res.status(result.status).send(result.message);
    const status = result.already ? "already" : "success";
    return res.redirect(`/unsubscribe.html?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}&status=${status}`);
  });

  app.post("/api/unsubscribe", unsubscribeLimiter, async (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const email = String(b.email || "").trim().toLowerCase();
    const token = String(b.token || "").trim();
    const reason = String(b.reason || "User unsubscribed").trim();
    const result = await processUnsubscribe(email, token, reason);
    if (!result.ok) return res.status(result.status).json({ success: false, error: result.message });
    return res.json({ success: true, message: result.message, already: !!result.already });
  });

  app.get("/api/suppressions", requireAuth, (_req, res) => {
    const suppressions = loadSuppressions();
    return res.json({ success: true, count: suppressions.length, suppressions });
  });

  app.post("/api/suppressions/add", requireAuth, async (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const reason = String(req.body?.reason || "Added by admin").trim();
    if (!email) return res.status(400).json({ success: false, error: "Email required" });
    await addSuppression(email, reason);
    return res.json({ success: true });
  });

  app.post("/api/recipients/validate", requireAuth, (req, res) => {
    const raw = req.body?.recipients || [];
    const valid: any[] = [];
    const invalid: any[] = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    raw.forEach((r: any) => {
      const email = typeof r === "string" ? r.trim() : (r.email || "").trim();
      const name = typeof r === "string" ? r.split("@")[0] : r.name || email.split("@")[0];
      const company = r.company || "Valued Client";
      if (email && emailRegex.test(email)) {
        const suppressed = isEmailSuppressed(email);
        valid.push({ email, name, company, status: suppressed ? "suppressed" : "valid", is_suppressed: suppressed });
      } else if (email) {
        invalid.push({ email, name, error: "Invalid email syntax" });
      }
    });
    res.json({ total_submitted: raw.length, valid_count: valid.length, invalid_count: invalid.length, valid_recipients: valid, invalid_recipients: invalid });
  });

  app.post("/api/campaign/start", requireAuth, async (req, res) => {
    const { recipients, template, settings } = req.body || {};
    const smtp = req.session.smtp;
    if (!smtp?.host || !smtp?.username) {
      return res.status(401).json({ success: false, error: "SMTP Session expired. Please log in again." });
    }
    if (!recipients?.length) {
      return res.status(400).json({ success: false, error: "No campaign recipients provided." });
    }

    let transporter: nodemailer.Transporter | null = null;
    try {
      transporter = createSmtpTransporter(smtp);
    } catch (e: any) {
      console.error("Transporter initialization error:", e);
    }

    currentCampaign = {
      status: "running",
      total: recipients.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      currentIndex: 0,
      logs: [{ time: new Date().toLocaleTimeString(), message: `Campaign initialized for ${recipients.length} recipients.`, level: "info" }],
      recipients: recipients.map((r: any) => ({ ...r, status: "pending" })),
      smtp,
      template,
      settings,
      transporter,
      isProcessing: false,
      baseUrl: getBaseUrl(req),
    };

    saveCampaignState();
    runCampaignQueue(req);
    res.json({ success: true, message: "Campaign started successfully.", total: recipients.length });
  });

  // --- Queue Execution with Transporter Guard, Log Trimming, Rate‑Limit Pause, and Persistence ---
  async function runCampaignQueue(req?: express.Request) {
    if (currentCampaign.isProcessing) return;
    currentCampaign.isProcessing = true;

    try {
      const { smtp, template, settings } = currentCampaign;
      if (!currentCampaign.transporter && smtp) {
        try {
          currentCampaign.transporter = createSmtpTransporter(smtp);
        } catch (e: any) {
          console.error("Failed to initialize transporter in queue:", e);
        }
      }
      let transporter = currentCampaign.transporter;

      const rawSpeed = parseInt(settings?.max_per_minute || process.env.MAX_EMAILS_PER_MINUTE || "15", 10);
      const speed = Math.max(Number.isFinite(rawSpeed) ? rawSpeed : 15, 1);
      const intervalMs = Math.max(Math.floor(60000 / speed), 1000);

      const attachments = template?.attachments || [];
      const fromEmail = (smtp?.from_email || smtp?.username || "trainings@edgevest.co.ke").trim();
      const fromName = sanitizeEmailText((smtp?.from_name || "Edgevest Team").trim());
      const baseUrl = (currentCampaign.baseUrl || getBaseUrl(req) || process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

      let consecutiveRateLimitWaits = 0;

      while (currentCampaign.status === "running" && currentCampaign.currentIndex < currentCampaign.total) {
        const idx = currentCampaign.currentIndex;
        const rec = currentCampaign.recipients[idx];
        const displayIndex = idx + 1;

        if (isEmailSuppressed(rec.email)) {
          currentCampaign.skipped++;
          currentCampaign.recipients[idx].status = "skipped";
          const logEntry = {
            time: new Date().toLocaleTimeString(),
            message: `[SKIPPED] ${rec.email} is suppressed.`,
            level: "warning",
          };
          currentCampaign.logs.push(logEntry);
          appendCampaignLog(logEntry);
          saveCampaignState();

          if (currentCampaign.logs.length > 1000) {
            currentCampaign.logs = currentCampaign.logs.slice(-500);
          }

          currentCampaign.currentIndex++;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        const displayName = sanitizeEmailText(rec.name || rec.email.split("@")[0] || "Valued Client");
        const displayCompany = sanitizeEmailText(rec.company || "Valued Client");

        let emailHtml = template?.body_html || "";
        const token = createUnsubscribeToken(rec.email);
        const unsubUrl = `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(rec.email)}&token=${encodeURIComponent(token)}`;

        if (typeof renderEdgevestEmailHTML === "function" && !String(emailHtml).includes("<!DOCTYPE")) {
          emailHtml = renderEdgevestEmailHTML(emailHtml, rec, baseUrl);
        } else {
          emailHtml = emailHtml.split("__UNSUBSCRIBE_URL__").join(unsubUrl);
          emailHtml = emailHtml.replace(/\{email\}/gi, rec.email);
        }

        let personalizedSubject = sanitizeEmailText((template?.subject || "Edgevest Update").replace(/\{name\}/gi, displayName));
        emailHtml = sanitizeEmailText(emailHtml);

        if (transporter) {
          const maxRetries = Math.min(Math.max(parseInt(settings?.max_retries || "2", 10), 0), 5);
          let attempts = 0;
          let lastError: any = null;
          let success = false;

          while (attempts <= maxRetries && !success) {
            try {
              const shouldRefresh = attempts > 0 || (currentCampaign.sent > 0 && currentCampaign.sent % 300 === 0);
              if (shouldRefresh) {
                try {
                  const newTransporter = createSmtpTransporter(smtp);
                  if (transporter) { try { transporter.close(); } catch (_) {} }
                  transporter = newTransporter;
                  currentCampaign.transporter = transporter;
                  const refreshLog = {
                    time: new Date().toLocaleTimeString(),
                    message: `[INFO] Refreshed SMTP connection (after ${currentCampaign.sent} sent / retry ${attempts})`,
                    level: "info",
                  };
                  currentCampaign.logs.push(refreshLog);
                  appendCampaignLog(refreshLog);
                } catch (err: any) {
                  const refreshFailLog = {
                    time: new Date().toLocaleTimeString(),
                    message: `[ERROR] Failed to refresh transporter: ${err.message}. Continuing with existing connection.`,
                    level: "error",
                  };
                  currentCampaign.logs.push(refreshFailLog);
                  appendCampaignLog(refreshFailLog);
                }
              }

              const userAttachments = (attachments || []).map((att: any) => {
                let filename = sanitizeEmailText((att.name || "attachment.pdf").replace(/\{name\}/gi, displayName));
                let contentStr = att.data || "";
                if (typeof contentStr === "string" && contentStr.includes(";base64,")) {
                  contentStr = contentStr.split(";base64,")[1];
                }
                return { filename, content: Buffer.from(contentStr, "base64") };
              });

              await transporter.sendMail({
                from: `"${fromName}" <${fromEmail}>`,
                to: rec.email,
                subject: personalizedSubject,
                html: emailHtml,
                encoding: "utf-8",
                textEncoding: "quoted-printable",
                attachments: userAttachments,
                headers: {
                  "List-Unsubscribe": `<${unsubUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
              });

              currentCampaign.sent++;
              currentCampaign.recipients[idx].status = "sent";
              const successLog = {
                time: new Date().toLocaleTimeString(),
                message: `[SUCCESS ${displayIndex}/${currentCampaign.total}] ${rec.email}`,
                level: "success",
              };
              currentCampaign.logs.push(successLog);
              appendCampaignLog(successLog);
              saveCampaignState();

              if (currentCampaign.logs.length > 1000) {
                currentCampaign.logs = currentCampaign.logs.slice(-500);
              }

              consecutiveRateLimitWaits = 0;
              success = true;
            } catch (sendErr: any) {
              lastError = sendErr;
              attempts++;

              const msg = (sendErr?.message || String(sendErr)).toLowerCase();
              const isRateLimit =
                msg.includes("rate") ||
                msg.includes("limit") ||
                msg.includes("too many") ||
                msg.includes("421") ||
                msg.includes("450") ||
                msg.includes("452") ||
                msg.includes("quota") ||
                msg.includes("throttl");

              if (isRateLimit) {
                const waitMs = 60000;
                const rateLog = {
                  time: new Date().toLocaleTimeString(),
                  message: `[RATE-LIMIT] ${rec.email}: ${sendErr.message}. Waiting ${waitMs/1000}s then retrying.`,
                  level: "warning",
                };
                currentCampaign.logs.push(rateLog);
                appendCampaignLog(rateLog);
                await new Promise(r => setTimeout(r, waitMs));
                attempts--;
                consecutiveRateLimitWaits++;
                if (consecutiveRateLimitWaits >= 5) {
                  currentCampaign.status = "paused";
                  const pauseLog = {
                    time: new Date().toLocaleTimeString(),
                    message: "Campaign paused due to repeated rate limiting.",
                    level: "warning",
                  };
                  currentCampaign.logs.push(pauseLog);
                  appendCampaignLog(pauseLog);
                  saveCampaignState();
                  break;
                }
                continue;
              }

              if (attempts <= maxRetries) {
                const backoffMs = 2000 * attempts;
                const retryLog = {
                  time: new Date().toLocaleTimeString(),
                  message: `[RETRY ${attempts}/${maxRetries}] ${rec.email}: ${sendErr.message}. Waiting ${backoffMs}ms…`,
                  level: "warning",
                };
                currentCampaign.logs.push(retryLog);
                appendCampaignLog(retryLog);
                await new Promise((r) => setTimeout(r, backoffMs));
              }
            }
          }

          if (!success && currentCampaign.status === "running") {
            currentCampaign.failed++;
            currentCampaign.recipients[idx].status = "failed";
            const failLog = {
              time: new Date().toLocaleTimeString(),
              message: `[FAILED ${displayIndex}/${currentCampaign.total}] ${rec.email}: ${lastError?.message || "Unknown error"}`,
              level: "error",
            };
            currentCampaign.logs.push(failLog);
            appendCampaignLog(failLog);
            saveCampaignState();

            if (currentCampaign.logs.length > 1000) {
              currentCampaign.logs = currentCampaign.logs.slice(-500);
            }
          }
        }

        currentCampaign.currentIndex++;
        if (currentCampaign.currentIndex < currentCampaign.total && currentCampaign.status === "running") {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }

      if (currentCampaign.currentIndex >= currentCampaign.total && currentCampaign.status === "running") {
        currentCampaign.status = "completed";
        const completeLog = {
          time: new Date().toLocaleTimeString(),
          message: `Finished. Sent ${currentCampaign.sent} | Skipped ${currentCampaign.skipped} | Failed ${currentCampaign.failed}`,
          level: "info",
        };
        currentCampaign.logs.push(completeLog);
        appendCampaignLog(completeLog);
        saveCampaignState();
      }

      if (currentCampaign.transporter) {
        try { currentCampaign.transporter.close(); } catch (_) {}
      }
    } finally {
      currentCampaign.isProcessing = false;
    }
  }

  // --- Campaign Control & Log Management Routes ---
  app.post("/api/campaign/pause", requireAuth, (_req, res) => {
    if (currentCampaign.status === "running") {
      currentCampaign.status = "paused";
      const pauseLog = { time: new Date().toLocaleTimeString(), message: "Paused.", level: "warning" };
      currentCampaign.logs.push(pauseLog);
      appendCampaignLog(pauseLog);
      saveCampaignState();
    }
    res.json({ success: true, status: currentCampaign.status });
  });

  app.post("/api/campaign/resume", requireAuth, (req, res) => {
    if (currentCampaign.status === "paused") {
      currentCampaign.status = "running";
      const resumeLog = { time: new Date().toLocaleTimeString(), message: "Resumed.", level: "info" };
      currentCampaign.logs.push(resumeLog);
      appendCampaignLog(resumeLog);
      saveCampaignState();
      runCampaignQueue(req);
    }
    res.json({ success: true, status: currentCampaign.status });
  });

  app.post("/api/campaign/cancel", requireAuth, (_req, res) => {
    currentCampaign.status = "cancelled";
    const cancelLog = { time: new Date().toLocaleTimeString(), message: "Cancelled.", level: "warning" };
    currentCampaign.logs.push(cancelLog);
    appendCampaignLog(cancelLog);
    saveCampaignState();
    res.json({ success: true, message: "Campaign cancelled." });
  });

  app.post("/api/campaign/log/add", requireAuth, (req, res) => {
    const { message, level, note } = req.body || {};
    if (!message) return res.status(400).json({ success: false, error: "Message required." });
    const logItem = {
      id: "log_" + Date.now(),
      time: new Date().toLocaleTimeString(),
      message,
      level: level || "info",
      note: note || "",
    };
    currentCampaign.logs.push(logItem);
    appendCampaignLog(logItem);
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

  app.post("/api/campaign/log/clear", requireAuth, (_req, res) => {
    currentCampaign.logs = [
      { time: new Date().toLocaleTimeString(), message: "Log console cleared.", level: "info" },
    ];
    res.json({ success: true });
  });

  app.get("/api/campaign/logs/export", requireAuth, (req, res) => {
    const format = req.query.format || "txt";
    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", 'attachment; filename="edgevest_campaign_logs.json"');
      return res.send(JSON.stringify(currentCampaign.logs, null, 2));
    }
    let textOutput = `EDGEVEST CAMPAIGN LOG\nStatus: ${currentCampaign.status}\n\n`;
    currentCampaign.logs.forEach((log: any, idx: number) => {
      textOutput += `[${idx + 1}] [${log.time}] ${log.message}\n`;
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", 'attachment; filename="edgevest_campaign_logs.log"');
    res.send(textOutput);
  });

  app.get("/api/campaign/status", requireAuth, (_req, res) => {
    const progress_percent = currentCampaign.total > 0 ? Math.round((currentCampaign.currentIndex / currentCampaign.total) * 100) : 0;
    res.json({
      status: currentCampaign.status,
      total: currentCampaign.total,
      sent: currentCampaign.sent,
      skipped: currentCampaign.skipped,
      failed: currentCampaign.failed,
      current_index: currentCampaign.currentIndex,
      progress_percent,
      logs: currentCampaign.logs.slice(-50),
      recipients_summary: currentCampaign.recipients,
    });
  });

  app.get("/api/campaign/stream", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const sendUpdate = () => {
      const progress_percent = currentCampaign.total > 0 ? Math.round((currentCampaign.currentIndex / currentCampaign.total) * 100) : 0;
      res.write(
        `data: ${JSON.stringify({
          type: "progress",
          data: {
            status: currentCampaign.status,
            total: currentCampaign.total,
            sent: currentCampaign.sent,
            skipped: currentCampaign.skipped,
            failed: currentCampaign.failed,
            current_index: currentCampaign.currentIndex,
            progress_percent,
            logs: currentCampaign.logs,
          },
        })}\n\n`
      );
      if (["completed", "cancelled", "failed"].includes(currentCampaign.status)) {
        clearInterval(interval);
        res.end();
      }
    };
    const interval = setInterval(sendUpdate, 1000);
    sendUpdate();
    req.on("close", () => clearInterval(interval));
  });

  // --- Static Files & Production SPA Fallback / Vite Block ---
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use("/public", express.static(path.join(process.cwd(), "public")));
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));
  app.use("/assets", express.static(path.join(process.cwd(), "public", "assets")));

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Campaign App running on http://localhost:${PORT}`);
  });
}

startServer();