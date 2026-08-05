import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import nodemailer from "nodemailer";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "10mb" }));

  // In-memory campaign state for Node preview runtime
  let currentCampaign = {
    status: "idle",
    total: 0,
    sent: 0,
    failed: 0,
    currentIndex: 0,
    logs: [] as any[],
    recipients: [] as any[],
    timer: null as any
  };

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "online", service: "Bulk Email Campaign Preview Server" });
  });

  app.post("/api/smtp/verify", async (req, res) => {
    const { host, port, username, password, use_ssl, use_tls } = req.body || {};
    if (!host || !host.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Hostname is required (e.g. mail.edgevest.co.ke or smtp.office365.com)." });
    }
    if (!port) {
      return res.status(400).json({ success: false, error: "SMTP Port is required (e.g. 465 or 587)." });
    }
    if (!username || !username.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Username / Email is required." });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ success: false, error: "SMTP Password is required to verify real connection and authentication." });
    }

    const portNum = parseInt(port, 10) || 587;
    const isSecure = use_ssl || portNum === 465;

    try {
      const transporter = nodemailer.createTransport({
        host: host.trim(),
        port: portNum,
        secure: isSecure,
        auth: {
          user: username.trim(),
          pass: password
        },
        tls: {
          rejectUnauthorized: false
        },
        connectionTimeout: 12000,
        greetingTimeout: 8000,
        socketTimeout: 15000
      });

      await transporter.verify();

      return res.json({
        success: true,
        message: `SMTP Connection & Authentication SUCCESSFUL! Authenticated with ${host}:${portNum} as ${username}.`
      });
    } catch (err: any) {
      let friendlyError = err.message || String(err);
      if (friendlyError.includes("535") || friendlyError.includes("EAUTH") || friendlyError.toLowerCase().includes("authentication")) {
        friendlyError = `Authentication Failed (535): Invalid username or password for ${host}. If using Office365 or Gmail, verify SMTP AUTH is enabled or use an App Password.`;
      } else if (friendlyError.includes("ETIMEDOUT") || friendlyError.includes("ECONNREFUSED") || friendlyError.includes("ESOCKET")) {
        friendlyError = `Connection Timeout/Refused (${host}:${portNum}): Unable to reach SMTP server. Verify hostname, port, or try Port 465 (SSL) vs Port 587 (STARTTLS).`;
      } else if (friendlyError.includes("SSL") || friendlyError.includes("TLS") || friendlyError.includes("wrong version")) {
        friendlyError = `SSL/TLS Handshake Error: Security mode mismatch on port ${portNum}. Select SSL/TLS Direct for Port 465 or STARTTLS for Port 587.`;
      }

      return res.status(400).json({
        success: false,
        error: friendlyError
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
    }

    currentCampaign = {
      status: "running",
      total: recipients.length,
      sent: 0,
      failed: 0,
      currentIndex: 0,
      logs: initLogs,
      recipients: recipients.map((r: any) => ({ ...r, status: "pending" })),
      timer: null
    };

    let transporter: nodemailer.Transporter | null = null;
    if (hasSmtpCreds) {
      try {
        const portNum = parseInt(smtp.port || "587", 10);
        transporter = nodemailer.createTransport({
          host: smtp.host,
          port: portNum,
          secure: smtp.use_ssl || portNum === 465,
          auth: { user: smtp.username, pass: smtp.password },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 15000
        });
      } catch (e: any) {
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `Transporter Initialization Error: ${e.message}`,
          level: "error"
        });
      }
    }

    const speed = Math.max(parseInt(settings?.max_per_minute || "30"), 1);
    const intervalMs = Math.max(Math.floor(60000 / speed), 300);

    currentCampaign.timer = setInterval(async () => {
      if (currentCampaign.status !== "running") return;

      if (currentCampaign.currentIndex >= currentCampaign.total) {
        currentCampaign.status = "completed";
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `Campaign complete! Sent: ${currentCampaign.sent}, Failed: ${currentCampaign.failed}`,
          level: "info"
        });
        clearInterval(currentCampaign.timer);
        return;
      }

      const rec = currentCampaign.recipients[currentCampaign.currentIndex];
      currentCampaign.currentIndex += 1;

      // Personalize subject & body
      let personalizedSubject = template?.subject || "Edgevest Update";
      let personalizedBody = template?.body_html || "<p>Hello {name}</p>";

      personalizedSubject = personalizedSubject.replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
                                                .replace(/\{email\}/gi, rec.email)
                                                .replace(/\{company\}/gi, rec.company || "Valued Client");

      personalizedBody = personalizedBody.replace(/\{name\}/gi, rec.name || rec.email.split("@")[0])
                                          .replace(/\{email\}/gi, rec.email)
                                          .replace(/\{company\}/gi, rec.company || "Valued Client");

      const attInfo = attachments.length > 0 ? ` [With ${attachments.length} Attachment(s): ${attNames}]` : "";

      if (transporter) {
        try {
          const formattedAttachments = attachments.map((att: any) => {
            let contentStr = att.data || "";
            if (typeof contentStr === "string" && contentStr.includes(";base64,")) {
              contentStr = contentStr.split(";base64,")[1];
            }
            return {
              filename: att.name,
              content: Buffer.from(contentStr, "base64")
            };
          });

          const fromEmail = smtp.from_email || smtp.username;
          const fromName = smtp.from_name || "Edgevest";

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
            message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] REAL EMAIL DELIVERED to ${rec.email} (Message-ID: ${info.messageId})${attInfo}`,
            level: "info"
          });
        } catch (mailErr: any) {
          rec.status = "failed";
          rec.error = mailErr.message || "SMTP Delivery Error";
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] REAL SMTP ERROR for ${rec.email}: ${mailErr.message}`,
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
            message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] [Simulated] Delivered to ${rec.email}${attInfo}`,
            level: "info"
          });
        } else {
          rec.status = "failed";
          rec.error = "550 5.1.1 User unknown (Simulated)";
          currentCampaign.failed += 1;
          currentCampaign.logs.push({
            time: new Date().toLocaleTimeString(),
            message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] [Simulated] Bounce/SMTP error for ${rec.email}: 550 5.1.1`,
            level: "error"
          });
        }
      }
    }, intervalMs);

    res.json({ success: true, message: "Campaign started.", total: recipients.length });
  });

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
    }
    res.json({ success: true, message: "Campaign resumed." });
  });

  app.post("/api/campaign/cancel", (req, res) => {
    if (currentCampaign.timer) clearInterval(currentCampaign.timer);
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
          logs: currentCampaign.logs.slice(-30)
        }
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

  // Serve /public static assets explicitly for both dev and production
  app.use("/public", express.static(path.join(process.cwd(), "public")));

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
