import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import nodemailer from "nodemailer";
import dns from "dns";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { suppressionStore } from "./src/storage.js";
import {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  injectUnsubscribeFooter
} from "./src/unsubscribe.js";
import {
  SESSION_COOKIE_NAME,
  getSessionSecret,
  getAdminCredentials,
  timingSafeCompare,
  generateSessionToken,
  verifySessionToken,
  sanitizeRedirectUrl
} from "./src/auth-session.js";
import {
  smtpSchema,
  recipientValidationSchema,
  campaignStartSchema,
  loginSchema,
  unsubscribeSchema
} from "./src/validation.js";

// Force Node to prioritize IPv4 DNS lookups to avoid ENETUNREACH on IPv6 addresses
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

// Custom lookup function for Nodemailer to guarantee strictly IPv4 resolution and avoid ENETUNREACH
const forceIPv4CustomLookup = (hostname: string, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};

  if (!hostname) {
    return callback(new Error("Hostname missing"));
  }

  // If hostname is already an IPv4 address string, return directly
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)) {
    if (options.all) return callback(null, [{ address: hostname, family: 4 }]);
    return callback(null, hostname, 4);
  }

  // Perform standard lookup forced to IPv4 (family 4)
  dns.lookup(hostname, { ...options, family: 4 }, (err, address, family) => {
    if (!err && address) {
      return callback(null, address, family);
    }
    // Fallback to explicit resolve4 A-record lookup
    dns.resolve4(hostname, (resErr, addrs) => {
      if (!resErr && addrs && addrs.length > 0) {
        if (options.all) {
          return callback(null, addrs.map((a) => ({ address: a, family: 4 })));
        }
        return callback(null, addrs[0], 4);
      }
      callback(err || resErr);
    });
  });
};

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Security Headers Middleware via Helmet (configured to allow Tailwind CDN, FontAwesome, & iframe embedding)
  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'",
            "'unsafe-eval'",
            "https://cdn.tailwindcss.com",
            "https://cdnjs.cloudflare.com"
          ],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            "https://cdn.tailwindcss.com",
            "https://cdnjs.cloudflare.com",
            "https://fonts.googleapis.com"
          ],
          fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          connectSrc: ["'self'", "https:", "wss:", "ws:"],
          frameAncestors: ["*"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  app.use(cookieParser(getSessionSecret()));
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // In-memory active bearer tokens
  const activeTokens = new Set<string>();

  // Rate limiters for sensitive endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 attempts per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many login attempts. Please try again in 15 minutes." }
  });

  const smtpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many SMTP verification requests. Please try again later." }
  });

  const campaignLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many campaign initialization requests. Please wait." }
  });

  // In-memory campaign state
  let currentCampaign: {
    status: string;
    total: number;
    sent: number;
    failed: number;
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

  // Helper to extract session or token from request
  const checkAuthentication = (req: express.Request): { authenticated: boolean; username: string | null } => {
    // 1. Check signed cookie session
    const sessionCookie = req.signedCookies?.[SESSION_COOKIE_NAME] || req.cookies?.[SESSION_COOKIE_NAME];
    if (sessionCookie) {
      const verified = verifySessionToken(sessionCookie);
      if (verified.valid) {
        return { authenticated: true, username: verified.username };
      }
    }

    // 2. Check Bearer token or x-auth-token or query.token
    const authHeader = req.headers.authorization;
    let token: string | null = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7).trim();
    } else if (typeof req.headers["x-auth-token"] === "string") {
      token = req.headers["x-auth-token"].trim();
    } else if (typeof req.query?.token === "string") {
      token = req.query.token.trim();
    }

    if (token) {
      if (activeTokens.has(token)) {
        return { authenticated: true, username: getAdminCredentials().username };
      }
      const verifiedToken = verifySessionToken(token);
      if (verifiedToken.valid) {
        activeTokens.add(token);
        return { authenticated: true, username: verifiedToken.username || getAdminCredentials().username };
      }
    }

    return { authenticated: false, username: null };
  };

  // Middleware enforcing authentication
  const requireAuthMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Public route exceptions
    const isPublic =
      req.path === "/api/health" ||
      req.path === "/login" ||
      req.path === "/api/login" ||
      req.path === "/api/auth/login" ||
      req.path === "/unsubscribe" ||
      req.path === "/api/unsubscribe" ||
      req.path === "/favicon.ico" ||
      req.path.startsWith("/assets/") ||
      req.path.startsWith("/public/assets/");

    if (isPublic) {
      return next();
    }

    const authState = checkAuthentication(req);
    const requireLoginFlag = process.env.REQUIRE_LOGIN === "true";

    if (authState.authenticated) {
      return next();
    }

    // If API route: return 401 JSON
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required. Please sign in with valid credentials.",
        auth_required: true
      });
    }

    // If page request and REQUIRE_LOGIN feature flag is set to true
    if (requireLoginFlag) {
      const nextParam = encodeURIComponent(sanitizeRedirectUrl(req.originalUrl));
      return res.redirect(`/login?next=${nextParam}`);
    }

    next();
  };

  app.use(requireAuthMiddleware);

  // PUBLIC UNSUBSCRIBE ROUTES
  app.get("/unsubscribe", (req, res) => {
    const unsubPath = path.join(process.cwd(), "public", "unsubscribe.html");
    if (fs.existsSync(unsubPath)) {
      return res.sendFile(unsubPath);
    }
    res.status(404).send("Unsubscribe page not found.");
  });

  app.post(["/unsubscribe", "/api/unsubscribe"], (req, res) => {
    const { token, email } = req.body || {};
    let targetEmail: string | null = email ? String(email).trim() : null;

    if (token) {
      const verifiedEmail = verifyUnsubscribeToken(token);
      if (verifiedEmail) {
        targetEmail = verifiedEmail;
      }
    }

    if (!targetEmail) {
      return res.status(400).json({
        success: false,
        error: "Invalid or expired unsubscribe token. Please use the original unsubscribe link from your email."
      });
    }

    suppressionStore.addSuppression(targetEmail, "user_unsubscribe", "web");
    suppressionStore.logUnsubscribeEvent(targetEmail, req.ip || "unknown", req.headers["user-agent"] || "unknown");

    res.json({
      success: true,
      email: targetEmail,
      message: `Email ${targetEmail} has been added to the suppression list. You will receive no further emails.`
    });
  });

  // PUBLIC LOGIN PAGE
  app.get("/login", (req, res) => {
    const authState = checkAuthentication(req);
    if (authState.authenticated) {
      const nextUrl = sanitizeRedirectUrl(req.query.next as string);
      return res.redirect(nextUrl);
    }
    const loginPath = path.join(process.cwd(), "public", "login.html");
    if (fs.existsSync(loginPath)) {
      return res.sendFile(loginPath);
    }
    res.status(404).send("Login page not found.");
  });

  // AUTHENTICATION ENDPOINTS
  app.get("/api/auth/check", (req, res) => {
    const authState = checkAuthentication(req);
    res.json({
      authenticated: authState.authenticated,
      username: authState.username
    });
  });

  app.post(["/api/auth/login", "/api/login"], authLimiter, (req, res) => {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: parseResult.error.issues.map((e) => e.message).join(", ")
      });
    }

    const { username, password } = parseResult.data;
    const creds = getAdminCredentials();

    const isUserMatch = timingSafeCompare(username.trim(), creds.username);
    const isPassMatch = timingSafeCompare(password.trim(), creds.password);

    if (isUserMatch && isPassMatch) {
      const sessionToken = generateSessionToken(creds.username);
      activeTokens.add(sessionToken);

      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        signed: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        sameSite: "none",
        secure: true
      });

      return res.json({
        success: true,
        token: sessionToken,
        username: creds.username,
        message: "Authentication successful."
      });
    }

    return res.status(401).json({
      success: false,
      error: "Invalid username or password. Please verify your environment credentials."
    });
  });

  app.post(["/api/auth/logout", "/api/logout"], (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME);
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      activeTokens.delete(authHeader.substring(7).trim());
    }
    res.json({ success: true, message: "Logged out successfully." });
  });

  // HEALTH CHECK
  app.get("/api/health", (req, res) => {
    res.json({
      status: "online",
      service: "Edgevest Bulk Email Campaign Server",
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      require_login: process.env.REQUIRE_LOGIN === "true",
      environment: process.env.NODE_ENV || "development",
      active_campaign: {
        status: currentCampaign.status,
        total: currentCampaign.total,
        sent: currentCampaign.sent,
        failed: currentCampaign.failed
      }
    });
  });

  // SUPPRESSIONS MANAGEMENT ENDPOINTS
  app.get("/api/suppressions", (req, res) => {
    const list = suppressionStore.listSuppressions();
    const events = suppressionStore.getUnsubscribeEvents();
    res.json({
      total_suppressed: list.length,
      suppressions: list,
      unsubscribe_events: events.slice(-50)
    });
  });

  app.post("/api/suppressions", (req, res) => {
    const { email, reason } = req.body || {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ success: false, error: "Valid email address required." });
    }
    const record = suppressionStore.addSuppression(email, reason || "manual_admin", "admin_dashboard");
    res.json({ success: true, record });
  });

  app.delete("/api/suppressions/:email", (req, res) => {
    const email = req.params.email;
    const removed = suppressionStore.removeSuppression(email);
    res.json({ success: removed, message: removed ? `Removed ${email} from suppression list.` : "Email not found." });
  });

  // SMTP VERIFICATION ENDPOINT
  app.post("/api/smtp/verify", smtpLimiter, async (req, res) => {
    const parseResult = smtpSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: parseResult.error.issues.map((e) => e.message).join(", ")
      });
    }

    const { host, port, username, password, use_ssl, use_tls } = parseResult.data;
    const portNum = Number(port) || 587;
    const cleanHost = host.trim();
    const cleanUser = username.trim();
    const isOffice365 = cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
    const isSecure = use_ssl || portNum === 465;

    const debugLogs: string[] = [];
    const customLogger = {
      level: () => "trace",
      trace: (e: any, ...a: any[]) => debugLogs.push(`[TRACE] ${typeof e === "string" ? e : JSON.stringify(e)}`),
      debug: (e: any, ...a: any[]) => debugLogs.push(`[DEBUG] ${typeof e === "string" ? e : JSON.stringify(e)}`),
      info: (e: any, ...a: any[]) => debugLogs.push(`[INFO] ${typeof e === "string" ? e : JSON.stringify(e)}`),
      warn: (e: any, ...a: any[]) => debugLogs.push(`[WARN] ${typeof e === "string" ? e : JSON.stringify(e)}`),
      error: (e: any, ...a: any[]) => debugLogs.push(`[ERROR] ${typeof e === "string" ? e : JSON.stringify(e)}`)
    };

    debugLogs.push(`[INIT] Starting SMTP verification for ${cleanHost}:${portNum} (User: ${cleanUser})`);

    try {
      const startTime = Date.now();
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

      await transporter.verify();
      const elapsed = Date.now() - startTime;

      return res.json({
        success: true,
        message: `SMTP Connection & Authentication SUCCESSFUL! Authenticated with ${cleanHost}:${portNum} as ${cleanUser}. (${elapsed}ms)`,
        logs: debugLogs
      });
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: `[SMTP Error] ${err.message || String(err)}`,
        logs: debugLogs
      });
    }
  });

  // RECIPIENT VALIDATION ENDPOINT
  app.post("/api/recipients/validate", (req, res) => {
    const parseResult = recipientValidationSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: parseResult.error.issues.map((e) => e.message).join(", ")
      });
    }

    const raw = parseResult.data.recipients;
    const valid: any[] = [];
    const invalid: any[] = [];
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    raw.forEach((r: any) => {
      const email = typeof r === "string" ? r.trim() : (r.email || "").trim();
      const name = typeof r === "string" ? r.split("@")[0] : r.name || email.split("@")[0];
      const company = r.company || "Valued Client";

      if (email && emailRegex.test(email)) {
        const isSuppressed = suppressionStore.isSuppressed(email);
        valid.push({
          email,
          name,
          company,
          status: isSuppressed ? "suppressed" : "valid",
          suppressed: isSuppressed
        });
      } else if (email) {
        invalid.push({ email, name, error: "Invalid email domain or syntax" });
      }
    });

    res.json({
      total_submitted: raw.length,
      valid_count: valid.filter((v) => !v.suppressed).length,
      suppressed_count: valid.filter((v) => v.suppressed).length,
      invalid_count: invalid.length,
      valid_recipients: valid,
      invalid_recipients: invalid
    });
  });

  // START CAMPAIGN ENDPOINT
  app.post("/api/campaign/start", campaignLimiter, async (req, res) => {
    const parseResult = campaignStartSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: parseResult.error.issues.map((e) => e.message).join(", ")
      });
    }

    const { smtp, recipients, template, settings } = parseResult.data;

    if (currentCampaign.timer) clearInterval(currentCampaign.timer);

    const attachments = template?.attachments || [];
    const attNames = attachments.map((a: any) => a.name).join(", ");
    const initLogs: any[] = [
      { time: new Date().toLocaleTimeString(), message: `Campaign initialized for ${recipients.length} recipients.`, level: "info" }
    ];

    if (attachments.length > 0) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign includes ${attachments.length} attachment(s): ${attNames}`,
        level: "info"
      });
    }

    // Check how many initial recipients are suppressed
    const suppressedCount = recipients.filter((r) => suppressionStore.isSuppressed(r.email)).length;
    if (suppressedCount > 0) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `[SUPPRESSION STORE] Identified ${suppressedCount} recipient(s) in global suppression list. These will be automatically skipped during dispatch.`,
        level: "warning"
      });
    }

    let transporter: nodemailer.Transporter | null = null;
    const hasSmtpCreds = smtp && smtp.host && smtp.password;
    if (!hasSmtpCreds) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `[NOTICE] No real SMTP Password provided. Running in Local Simulation Mode.`,
        level: "warning"
      });
    } else {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `[REAL SMTP ENGINE] Configured server: ${smtp.host}:${smtp.port} (${smtp.from_email || smtp.username})`,
        level: "info"
      });
      try {
        const portNum = Number(smtp.port || 587);
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
    }

    currentCampaign = {
      status: "running",
      total: recipients.length,
      sent: 0,
      failed: 0,
      currentIndex: 0,
      logs: initLogs,
      recipients: recipients.map((r: any) => ({
        ...r,
        status: suppressionStore.isSuppressed(r.email) ? "suppressed" : "pending"
      })),
      smtp,
      template,
      settings,
      transporter,
      isProcessing: false
    };

    runCampaignQueue(req);

    res.json({ success: true, message: "Campaign started.", total: recipients.length });
  });

  // CAMPAIGN QUEUE DISPATCH ENGINE
  async function runCampaignQueue(req?: express.Request) {
    if (currentCampaign.isProcessing) return;
    currentCampaign.isProcessing = true;

    const { smtp, template, settings, transporter } = currentCampaign;
    const speed = Math.max(Number(settings?.max_per_minute || 30), 1);
    const intervalMs = Math.max(Math.floor(60000 / speed), 300);
    const attachments = template?.attachments || [];
    const fromEmail = (smtp?.from_email || smtp?.username || "no-reply@edgevest.com").trim();
    const fromName = (smtp?.from_name || "Edgevest").trim();

    // Determine host base URL for unsubscribe links
    let baseUrl = "http://localhost:" + PORT;
    if (req) {
      const hostHeader = req.headers.host;
      const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
      if (hostHeader) {
        baseUrl = `${protocol}://${hostHeader}`;
      }
    }

    while (currentCampaign.status === "running" && currentCampaign.currentIndex < currentCampaign.total) {
      const idx = currentCampaign.currentIndex;
      const rec = currentCampaign.recipients[idx];
      const displayIndex = idx + 1;

      // CHECK SUPPRESSION STORE BEFORE DISPATCH
      if (suppressionStore.isSuppressed(rec.email)) {
        rec.status = "suppressed";
        rec.error = "Email address is in global suppression list.";
        currentCampaign.failed += 1;
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[${displayIndex}/${currentCampaign.total}] [SUPPRESSED] Skipping ${rec.email} (Recipient unsubscribed)`,
          level: "warning"
        });
        currentCampaign.currentIndex += 1;
        continue;
      }

      // Personalize subject & body
      let personalizedSubject = template?.subject || "Edgevest Update";
      let personalizedBody = template?.body_html || "<p>Hello {name}</p>";

      personalizedSubject = personalizedSubject
        .replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
        .replace(/\{email\}/gi, rec.email)
        .replace(/\{company\}/gi, rec.company || "Valued Client");

      personalizedBody = personalizedBody
        .replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
        .replace(/\{email\}/gi, rec.email)
        .replace(/\{company\}/gi, rec.company || "Valued Client");

      // Inject Unsubscribe Link & Headers
      const unsubUrl = buildUnsubscribeUrl(baseUrl, rec.email);
      personalizedBody = injectUnsubscribeFooter(personalizedBody, unsubUrl);

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
              filename,
              content: Buffer.from(contentStr, "base64")
            };
          });

          await transporter.sendMail({
            from: `"${fromName}" <${fromEmail}>`,
            to: rec.email,
            subject: personalizedSubject,
            html: personalizedBody,
            attachments: userAttachments,
            headers: {
              "List-Unsubscribe": `<${unsubUrl}>, <mailto:unsubscribe@edgevest.com>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
            }
          });

          rec.status = "sent";
          currentCampaign.sent += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [SMTP SUCCESS] Delivered to ${rec.email}`,
            level: "success"
          });
        } catch (mailErr: any) {
          rec.status = "failed";
          rec.error = mailErr.message;
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [SMTP FAIL] Delivery error for ${rec.email}: ${mailErr.message}`,
            level: "error"
          });
        }
      } else {
        // Local Simulation Mode
        if (Math.random() > 0.1) {
          rec.status = "sent";
          currentCampaign.sent += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [Simulated] Delivered email to ${rec.email}`,
            level: "info"
          });
        } else {
          rec.status = "failed";
          rec.error = "550 5.1.1 User unknown (Simulated)";
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [Simulated] Bounce for ${rec.email}: 550 5.1.1`,
            level: "error"
          });
        }
      }

      currentCampaign.currentIndex += 1;

      if (currentCampaign.status === "running" && currentCampaign.currentIndex < currentCampaign.total) {
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }

    if (currentCampaign.status === "running" && currentCampaign.currentIndex >= currentCampaign.total) {
      currentCampaign.status = "completed";
      currentCampaign.logs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign complete! Sent: ${currentCampaign.sent}, Failed: ${currentCampaign.failed}`,
        level: "info"
      });
    }

    currentCampaign.isProcessing = false;
  }

  // CAMPAIGN CONTROLS
  app.post("/api/campaign/pause", (req, res) => {
    if (currentCampaign.status === "running") {
      currentCampaign.status = "paused";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign paused by operator.", level: "warning" });
    }
    res.json({ success: true, message: "Campaign paused." });
  });

  app.post("/api/campaign/resume", (req, res) => {
    if (currentCampaign.status === "paused") {
      currentCampaign.status = "running";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign resumed.", level: "info" });
      runCampaignQueue(req);
    }
    res.json({ success: true, message: "Campaign resumed." });
  });

  app.post("/api/campaign/cancel", (req, res) => {
    currentCampaign.status = "cancelled";
    currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign cancelled.", level: "warning" });
    res.json({ success: true, message: "Campaign cancelled." });
  });

  // LOG MANAGEMENT
  app.post("/api/campaign/log/add", (req, res) => {
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

  app.post("/api/campaign/log/clear", (req, res) => {
    currentCampaign.logs = [{ time: new Date().toLocaleTimeString(), message: "Console cleared.", level: "info" }];
    res.json({ success: true, message: "Logs cleared." });
  });

  app.get("/api/campaign/status", (req, res) => {
    const progress_percent = currentCampaign.total > 0
      ? Math.round((currentCampaign.currentIndex / currentCampaign.total) * 100)
      : 0;

    res.json({
      status: currentCampaign.status,
      total: currentCampaign.total,
      sent: currentCampaign.sent,
      failed: currentCampaign.failed,
      current_index: currentCampaign.currentIndex,
      progress_percent,
      logs: currentCampaign.logs.slice(-30),
      recipients_summary: currentCampaign.recipients
    });
  });

  app.get("/api/campaign/stream", (req, res) => {
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

    req.on("close", () => clearInterval(interval));
  });

  // PAGE ROUTES
  app.get("/login", (req, res) => {
    const loginPath = path.join(process.cwd(), "public", "login.html");
    if (fs.existsSync(loginPath)) {
      return res.sendFile(loginPath);
    }
    res.redirect("/campaign.html");
  });

  app.get(["/campaign.html", "/index.html", "/"], (req, res, next) => {
    if (req.query.dev === "true") {
      return next(); // Let Vite handle React DevTools view when ?dev=true
    }
    const distPath = path.join(process.cwd(), "dist", "campaign.html");
    const publicPath = path.join(process.cwd(), "public", "campaign.html");
    if (fs.existsSync(distPath)) {
      return res.sendFile(distPath);
    } else if (fs.existsSync(publicPath)) {
      return res.sendFile(publicPath);
    }
    next();
  });

  // STATIC SERVING
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use("/public", express.static(path.join(process.cwd(), "public")));

  // VITE DEV MIDDLEWARE FOR SPA / HMR
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
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
