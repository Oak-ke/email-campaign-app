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

    currentCampaign = {
      status: "running",
      total: recipients.length,
      sent: 0,
      failed: 0,
      currentIndex: 0,
      logs: [{ time: new Date().toLocaleTimeString(), message: `Campaign initialized for ${recipients.length} recipients.`, level: "info" }],
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
      if (isSuccess) {
        rec.status = "sent";
        currentCampaign.sent += 1;
        currentCampaign.logs.push({
          time: new Date().toLocaleTimeString(),
          message: `[${currentCampaign.currentIndex}/${currentCampaign.total}] Delivered to ${rec.email}`,
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
    const allowed = ["app.py", "config.py", "passenger_wsgi.py", "requirements.txt", ".env.example", "public/index.html"];
    if (!allowed.includes(fn)) {
      return res.status(400).send("Invalid file.");
    }
    const filePath = path.join(process.cwd(), fn);
    if (fs.existsSync(filePath)) {
      res.download(filePath);
    } else {
      res.status(404).send("File not found.");
    }
  });

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
