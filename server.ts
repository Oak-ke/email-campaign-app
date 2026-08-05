import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";

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

  app.post("/api/smtp/verify", (req, res) => {
    const { host, port, username } = req.body || {};
    if (!host || !port) {
      return res.status(400).json({ success: false, error: "Host and Port are required." });
    }
    // Simulate SMTP verify test
    setTimeout(() => {
      res.json({
        success: true,
        message: `Connection successful to ${host}:${port} (${username || 'anonymous'}).`
      });
    }, 600);
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

  app.post("/api/campaign/start", (req, res) => {
    const { recipients, template, settings } = req.body || {};
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

    const speed = Math.max(parseInt(settings?.max_per_minute || "30"), 1);
    const intervalMs = Math.max(Math.floor(60000 / speed), 300);

    currentCampaign.timer = setInterval(() => {
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

      // Simulate sending
      const isSuccess = Math.random() > 0.05; // 95% deliverability in demo
      const attInfo = attachments.length > 0 ? ` [With PDF/Attachment: ${attNames}]` : "";
      if (isSuccess) {
        rec.status = "sent";
        currentCampaign.sent += 1;
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] Delivered to ${rec.email}${attInfo}`,
          level: "info"
        });
      } else {
        rec.status = "failed";
        rec.error = "550 5.1.1 User unknown";
        currentCampaign.failed += 1;
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] Bounce/SMTP error for ${rec.email}: 550 5.1.1`,
          level: "error"
        });
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
