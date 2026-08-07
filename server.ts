import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import nodemailer from "nodemailer";
import dns from "dns";

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
          return callback(null, addrs.map(a => ({ address: a, family: 4 })));
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

  app.use(express.json({ limit: "10mb" }));

  // In-memory campaign state for Node preview runtime
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

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", service: "Bulk Email Campaign Preview Server" });
  });

  app.post("/api/smtp/verify", async (req, res) => {
    const { host, port, username, password, use_ssl, use_tls } = req.body || {};
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
      return res.status(400).json({ success: false, error: "SMTP Password is required to verify real connection and authentication." });
    }

    const portNum = parseInt(port, 10) || 587;
    const cleanHost = host.trim();
    const cleanUser = username.trim();
    const isOffice365 = cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
    const isSecure = use_ssl || portNum === 465;

    const debugLogs: string[] = [];

    // Diagnostic logger capturing Nodemailer protocol steps
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

    debugLogs.push(`[INIT] Starting SMTP verification for ${cleanHost}:${portNum} (User: ${cleanUser})`);

    // Step 1: DNS Resolution Check
    let resolvedIps: string[] = [];
    try {
      debugLogs.push(`[DNS] Resolving IPv4 addresses for hostname: "${cleanHost}"...`);
      resolvedIps = await new Promise((resolve) => {
        dns.resolve4(cleanHost, (err, addrs) => resolve(err ? [] : addrs));
      });
      if (resolvedIps.length > 0) {
        debugLogs.push(`[DNS SUCCESS] "${cleanHost}" resolved to IPv4: [${resolvedIps.join(", ")}]`);
      } else {
        debugLogs.push(`[DNS INFO] Direct DNS lookup didn't yield A records directly, falling back to IPv4 system lookup.`);
      }
    } catch (dnsErr: any) {
      debugLogs.push(`[DNS WARN] DNS pre-check error: ${dnsErr.message}`);
    }

    // Step 2: Transport Configuration
    debugLogs.push(`[CONFIG] Socket security mode: ${isSecure ? 'Direct SSL/TLS (Implicit)' : 'STARTTLS (Explicit)'}`);
    debugLogs.push(`[CONFIG] Socket timeouts: Connection=15000ms, Greeting=15000ms, Socket=15000ms`);

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
        authMethod: "LOGIN", // Explicitly use AUTH LOGIN (matching standard Office 365 socket behavior)
        auth: {
          user: cleanUser,
          pass: password
        },
        tls: {
          rejectUnauthorized: false,
          servername: cleanHost
        },
        connectionTimeout: 15000, // 15-second connection timeout matching test script
        greetingTimeout: 15000,   // 15-second greeting timeout
        socketTimeout: 15000      // 15-second socket timeout
      } as any);

      debugLogs.push(`[HANDSHAKE] Sending SMTP EHLO/HELO and initiating TLS handshake (15s timeout limit)...`);

      // Wrap verification in a 16000ms Promise.race
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Connection Timeout: Socket connection or response timed out after 15000ms trying to connect to ${cleanHost}:${portNum}`));
        }, 16000);
      });

      await Promise.race([transporter.verify(), timeoutPromise]);
      const elapsed = Date.now() - startTime;

      debugLogs.push(`[SUCCESS] Connection & Authentication verified in ${elapsed}ms!`);

      return res.json({
        success: true,
        message: `SMTP Connection & Authentication SUCCESSFUL! Authenticated with ${cleanHost}:${portNum} as ${cleanUser}. (${elapsed}ms)`,
        logs: debugLogs,
        resolved_ips: resolvedIps
      });
    } catch (err: any) {
      let rawErrorMsg = err.message || String(err);
      const lowerErr = rawErrorMsg.toLowerCase();
      const errCode = (err.code || "").toUpperCase();

      debugLogs.push(`[FAIL] Verification error encountered: ${rawErrorMsg}`);

      let friendlyError = "";
      let errorType: "AUTH_FAILED" | "CONNECTION_TIMEOUT" | "TLS_ERROR" | "GENERAL_ERROR" = "GENERAL_ERROR";

      // Check for Authentication Failures (SMTP 535 / EAUTH / bad password / auth rejection)
      if (
        rawErrorMsg.includes("535") ||
        rawErrorMsg.includes("534") ||
        rawErrorMsg.includes("530") ||
        errCode === "EAUTH" ||
        lowerErr.includes("eauth") ||
        lowerErr.includes("authentication failed") ||
        lowerErr.includes("invalid credentials") ||
        lowerErr.includes("username and password not accepted")
      ) {
        errorType = "AUTH_FAILED";
        friendlyError = `[Authentication Failed] Credentials rejected for ${cleanUser} on ${cleanHost}:${portNum}.\n\n` +
          `🔑 Failure Details: The SMTP server was reached successfully, but rejected the login username/password.\n\n` +
          `💡 Troubleshooting Steps:\n` +
          `1. Check password accuracy for ${cleanUser}.\n` +
          `2. For Microsoft 365 / Outlook: Ensure 'Authenticated SMTP' is enabled in M365 Admin Center (Active Users -> [User] -> Mail tab -> Manage email apps -> Check 'Authenticated SMTP').\n` +
          `3. If 2-Factor Authentication (2FA) is enabled, generate an App Password at https://mysignins.microsoft.com/ and use it instead of your main password.`;
      } 
      // Check for Connection Timeout / Network unreachable
      else if (
        errCode === "ETIMEDOUT" ||
        errCode === "ECONNREFUSED" ||
        errCode === "ESOCKET" ||
        errCode === "EHOSTUNREACH" ||
        errCode === "ENETUNREACH" ||
        lowerErr.includes("timeout") ||
        lowerErr.includes("timed out") ||
        lowerErr.includes("etimedout") ||
        lowerErr.includes("econnrefused") ||
        lowerErr.includes("esocket") ||
        lowerErr.includes("enetunreach")
      ) {
        errorType = "CONNECTION_TIMEOUT";
        friendlyError = `[Connection Timeout] Unable to connect to SMTP server ${cleanHost}:${portNum} within 5 seconds.\n\n` +
          `⏱️ Failure Details: The socket timed out after 5 seconds before receiving an SMTP handshake response from ${cleanHost}:${portNum}.\n\n` +
          `💡 Troubleshooting Steps:\n` +
          `1. Verify Host is correct (e.g. 'outlook.office365.com' or 'smtp.office365.com').\n` +
          `2. Check Port and Security setting: Use Port 587 with STARTTLS or Port 465 with Direct SSL.\n` +
          `3. Note: Cloud sandbox environments often block outbound SMTP ports (25/587/465). The configuration will connect once deployed to your hosting environment.`;
      } 
      // Check for SSL/TLS Handshake issues
      else if (lowerErr.includes("ssl") || lowerErr.includes("tls") || lowerErr.includes("wrong version") || lowerErr.includes("handshake")) {
        errorType = "TLS_ERROR";
        friendlyError = `[SSL/TLS Handshake Error] Security handshake failed on ${cleanHost}:${portNum}.\n\n` +
          `🔒 Failure Details: ${rawErrorMsg}\n\n` +
          `💡 Troubleshooting Steps:\n` +
          `1. For Port 587, uncheck 'Direct SSL/TLS' and check 'STARTTLS'.\n` +
          `2. For Port 465, check 'Direct SSL/TLS'.`;
      } 
      else {
        friendlyError = `[SMTP Error] ${rawErrorMsg}`;
      }

      return res.status(400).json({
        success: false,
        error: friendlyError,
        error_type: errorType,
        logs: debugLogs,
        resolved_ips: resolvedIps
      });
    }
  });

  app.post("/api/recipients/validate", (req, res) => {
    const raw = req.body?.recipients || [];
    const valid: any[] = [];
    const invalid: any[] = [];

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    raw.forEach((r: any) => {
      const email = typeof r === "string" ? r.trim() : (r.email || "").trim();
      const name = typeof r === "string" ? r.split("@")[0] : (r.name || email.split("@")[0]);
      const company = r.company || "Valued Client";

      if (email && emailRegex.test(email)) {
        valid.push({ email, name, company, status: "valid" });
      } else if (email) {
        invalid.push({ email, name, error: "Invalid email domain or syntax" });
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

  app.post("/api/campaign/start", async (req, res) => {
    const { smtp, recipients, template, settings } = req.body || {};
    if (!recipients || recipients.length === 0) {
      return res.status(400).json({ success: false, error: "No recipients provided." });
    }

    if (currentCampaign.timer) clearInterval(currentCampaign.timer);

    const attachments = template?.attachments || [];
    const attNames = attachments.map((a: any) => a.name).join(", ");
    const initLogs: any[] = [{ time: new Date().toLocaleTimeString(), message: `Campaign initialized for ${recipients.length} recipients.`, level: "info" }];
    
    if (attachments.length > 0) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign includes ${attachments.length} attachment(s): ${attNames}`,
        level: "info"
      });
    }

    let transporter: nodemailer.Transporter | null = null;
    const hasSmtpCreds = smtp && smtp.host && smtp.password;
    if (!hasSmtpCreds) {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `[NOTICE] No real SMTP Password was provided in Step 1. Running in Local Simulation Mode (no real email dispatched to inbox). Enter your real SMTP credentials in Step 1 to send live emails.`,
        level: "warning"
      });
    } else {
      initLogs.push({
        time: new Date().toLocaleTimeString(),
        message: `[REAL SMTP ENGINE] Configured with server: ${smtp.host}:${smtp.port} (${smtp.from_email || smtp.username})`,
        level: "info"
      });
      try {
        const portNum = parseInt(smtp.port || "587", 10);
        const cleanHost = (smtp.host || "").trim();
        const cleanUser = (smtp.username || "").trim();
        const isOffice365 = cleanHost.toLowerCase().includes("office365") || cleanHost.toLowerCase().includes("outlook");
        const isSecure = smtp.use_ssl || portNum === 465;

        transporter = nodemailer.createTransport({
          host: cleanHost,
          port: portNum,
          secure: isSecure,
          requireTLS: portNum === 587 || smtp.use_tls || isOffice365,
          family: 4,
          lookup: forceIPv4CustomLookup,
          authMethod: "LOGIN",
          auth: { user: cleanUser, pass: smtp.password },
          tls: {
            rejectUnauthorized: false,
            servername: cleanHost
          },
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
      recipients: recipients.map((r: any) => ({ ...r, status: "pending" })),
      smtp,
      template,
      settings,
      transporter,
      isProcessing: false
    };

    runCampaignQueue();

    res.json({ success: true, message: "Campaign started.", total: recipients.length });
  });

  async function runCampaignQueue() {
    if (currentCampaign.isProcessing) return;
    currentCampaign.isProcessing = true;

    const { smtp, template, settings, transporter } = currentCampaign;
    const speed = Math.max(parseInt(settings?.max_per_minute || "30"), 1);
    const intervalMs = Math.max(Math.floor(60000 / speed), 300);
    const attachments = template?.attachments || [];
    const attNames = attachments.map((a: any) => a.name).join(", ");

    while (
      currentCampaign.status === "running" &&
      currentCampaign.currentIndex < currentCampaign.total
    ) {
      const idx = currentCampaign.currentIndex;
      const rec = currentCampaign.recipients[idx];
      const displayIndex = idx + 1;

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

      const attInfo = attachments.length > 0 ? ` [With ${attachments.length} Attachment(s): ${attNames}]` : "";

      if (transporter) {
        try {
          const formattedAttachments = attachments.map((att: any) => {
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

          const fromEmail = smtp?.from_email || smtp?.username;
          const fromName = smtp?.from_name || "Edgevest";

          const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to: rec.email,
            subject: personalizedSubject,
            html: personalizedBody,
            attachments: formattedAttachments
          };

          const info = await transporter.sendMail(mailOptions);
          rec.status = "sent";
          currentCampaign.sent += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] REAL EMAIL DELIVERED to ${rec.email} (Message-ID: ${info.messageId})${attInfo}`,
            level: "info"
          });
        } catch (mailErr: any) {
          rec.status = "failed";
          rec.error = mailErr.message || "SMTP Delivery Error";
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] REAL SMTP ERROR for ${rec.email}: ${mailErr.message}`,
            level: "error"
          });
        }
      } else {
        // Fallback simulation mode
        const isSuccess = Math.random() > 0.05;
        if (isSuccess) {
          rec.status = "sent";
          currentCampaign.sent += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [Simulated] Delivered to ${rec.email}${attInfo}`,
            level: "info"
          });
        } else {
          rec.status = "failed";
          rec.error = "550 5.1.1 User unknown (Simulated)";
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${displayIndex}/${currentCampaign.total}] [Simulated] Bounce/SMTP error for ${rec.email}: 550 5.1.1`,
            level: "error"
          });
        }
      }

      currentCampaign.currentIndex += 1;

      // Check if campaign should pause/stop or delay before next email
      if (
        currentCampaign.status === "running" &&
        currentCampaign.currentIndex < currentCampaign.total
      ) {
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }

    if (
      currentCampaign.status === "running" &&
      currentCampaign.currentIndex >= currentCampaign.total
    ) {
      currentCampaign.status = "completed";
      currentCampaign.logs.push({
        time: new Date().toLocaleTimeString(),
        message: `Campaign complete! Sent: ${currentCampaign.sent}, Failed: ${currentCampaign.failed}`,
        level: "info"
      });
    }

    currentCampaign.isProcessing = false;
  }

  app.post("/api/campaign/pause", (req, res) => {
    if (currentCampaign.status === "running") {
      currentCampaign.status = "paused";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign paused by admin.", level: "warning" });
    }
    res.json({ success: true, message: "Campaign paused." });
  });

  app.post("/api/campaign/resume", (req, res) => {
    if (currentCampaign.status === "paused") {
      currentCampaign.status = "running";
      currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign resumed.", level: "info" });
      runCampaignQueue();
    }
    res.json({ success: true, message: "Campaign resumed." });
  });

  app.post("/api/campaign/cancel", (req, res) => {
    currentCampaign.status = "cancelled";
    currentCampaign.logs.push({ time: new Date().toLocaleTimeString(), message: "Campaign cancelled.", level: "warning" });
    res.json({ success: true, message: "Campaign cancelled." });
  });

  // Log Management API Endpoints
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

  app.post("/api/campaign/log/edit", (req, res) => {
    const { index, message, note, level } = req.body || {};
    if (index === undefined || index < 0 || index >= currentCampaign.logs.length) {
      return res.status(400).json({ success: false, error: "Invalid log index." });
    }
    if (message !== undefined) currentCampaign.logs[index].message = message;
    if (note !== undefined) currentCampaign.logs[index].note = note;
    if (level !== undefined) currentCampaign.logs[index].level = level;
    res.json({ success: true, updated: currentCampaign.logs[index] });
  });

  app.post("/api/campaign/log/delete", (req, res) => {
    const { index } = req.body || {};
    if (index === undefined || index < 0 || index >= currentCampaign.logs.length) {
      return res.status(400).json({ success: false, error: "Invalid log index." });
    }
    const removed = currentCampaign.logs.splice(index, 1);
    res.json({ success: true, removed });
  });

  app.post("/api/campaign/log/clear", (req, res) => {
    currentCampaign.logs = [{ time: new Date().toLocaleTimeString(), message: "Log console cleared by operator.", level: "info" }];
    res.json({ success: true, message: "Logs cleared." });
  });

  app.get("/api/campaign/logs/export", (req, res) => {
    const format = req.query.format || "txt";
    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", 'attachment; filename="edgevest_campaign_logs.json"');
      return res.send(JSON.stringify(currentCampaign.logs, null, 2));
    }
    
    let textOutput = `========================================================\n`;
    textOutput += `EDGEVEST EMAIL CAMPAIGN MANAGER - EXECUTION LOG REPORT\n`;
    textOutput += `Generated: ${new Date().toLocaleString()}\n`;
    textOutput += `Status: ${currentCampaign.status.toUpperCase()} | Sent: ${currentCampaign.sent} | Failed: ${currentCampaign.failed} | Total: ${currentCampaign.total}\n`;
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

      // Automatically end SSE stream when campaign completes, fails, or is cancelled
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
    const allowed = ["app.py", "config.py", "passenger_wsgi.py", "requirements.txt", ".env.example", "public/campaign.html", "public/index.html"];
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

  // Explicit route for /campaign.html to ensure it is served in all environments
  app.get("/campaign.html", (req, res, next) => {
    const distPath = path.join(process.cwd(), "dist", "campaign.html");
    const publicPath = path.join(process.cwd(), "public", "campaign.html");
    if (fs.existsSync(distPath)) {
      return res.sendFile(distPath);
    } else if (fs.existsSync(publicPath)) {
      return res.sendFile(publicPath);
    }
    next();
  });

  // Serve static assets explicitly for both dev and production
  app.use(express.static(path.join(process.cwd(), "public")));
  app.use("/public", express.static(path.join(process.cwd(), "public")));
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));
  app.use("/assets", express.static(path.join(process.cwd(), "public", "assets")));
  app.use("/assets", express.static(path.join(process.cwd(), "src", "assets")));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Campaign App running on http://localhost:${PORT}`);
  });
}

startServer();
