import React, { useState } from 'react';
import { Copy, Download, Check, FileCode } from 'lucide-react';

const fileContents: Record<string, { label: string; desc: string; code: string; lang: string }> = {
  'app.py': {
    label: 'app.py',
    desc: 'Main Flask application backend with Threading Campaign Engine, Rate Limiter & SSE Stream',
    lang: 'python',
    code: `"""
Bulk Email Campaign Manager - Corrected Flask Backend.
Provides multi-threaded background email queueing, rate limiting,
SSE progress streaming, SMTP connection testing, and email validation.
"""

import os
import sys
import time
import json
import queue
import threading
import smtplib
import logging
import re
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr

from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS
from flask_httpauth import HTTPBasicAuth
from email_validator import validate_email, EmailNotValidError

from config import Config

# Initialize Flask App
app = Flask(__name__, public_folder="public", static_folder="public")
app.config.from_object(Config)

# Enable CORS safely
CORS(app, origins=app.config.get("CORS_ALLOWED_ORIGINS", "*"))

# Initialize Authentication
auth = HTTPBasicAuth()

# Configure Logging with Password Redaction
class SensitiveFilter(logging.Filter):
    def filter(self, record):
        if hasattr(record, 'msg') and isinstance(record.msg, str):
            record.msg = re.sub(r'(password["\\']?\\s*:\\s*["\\']?)[^"\\']+', r'\\1****', record.msg, flags=re.IGNORECASE)
        return True

logging.basicConfig(
    level=getattr(logging, app.config.get("LOG_LEVEL", "INFO").upper()),
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("campaign_app.log")
    ]
)
logger = logging.getLogger("EmailCampaign")
logger.addFilter(SensitiveFilter())


@auth.verify_password
def verify_password(username, password):
    """Basic Auth Verification"""
    expected_user = app.config.get("ADMIN_USERNAME", "admin")
    expected_pass = app.config.get("ADMIN_PASSWORD", "admin123")
    if username == expected_user and password == expected_pass:
        return username
    return None


# ==========================================
# BACKGROUND EMAIL CAMPAIGN ENGINE
# ==========================================

class CampaignEngine:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = "idle"  # idle, running, paused, completed, cancelled, error
        self.total_emails = 0
        self.sent_count = 0
        self.failed_count = 0
        self.current_index = 0
        self.recipients = []
        self.smtp_config = {}
        self.template = {}
        self.settings = {}
        self.logs = []
        self.subscribers = []  # SSE listeners
        self.worker_thread = None
        self.stop_requested = False
        self.pause_requested = False

    def log_event(self, message, level="info"):
        timestamp = time.strftime("%H:%M:%S")
        entry = {"time": timestamp, "message": message, "level": level}
        with self.lock:
            self.logs.append(entry)
            if len(self.logs) > 500:
                self.logs.pop(0)
        self.broadcast_sse({"type": "log", "data": entry})
        if level == "error":
            logger.error(message)
        else:
            logger.info(message)

    def broadcast_sse(self, data):
        data_str = f"data: {json.dumps(data)}\\n\\n"
        with self.lock:
            for q in list(self.subscribers):
                try:
                    q.put_nowait(data_str)
                except queue.Full:
                    pass

    def get_status_payload(self):
        with self.lock:
            return {
                "status": self.status,
                "total": self.total_emails,
                "sent": self.sent_count,
                "failed": self.failed_count,
                "current_index": self.current_index,
                "progress_percent": round((self.current_index / self.total_emails * 100), 1) if self.total_emails > 0 else 0,
                "logs": self.logs[-20:],
                "recipients_summary": [
                    {
                        "email": r.get("email"),
                        "name": r.get("name", ""),
                        "status": r.get("status", "pending"),
                        "error": r.get("error", "")
                    }
                    for r in self.recipients
                ]
            }

    def start(self, recipients, template, smtp_config, settings):
        with self.lock:
            if self.status in ("running", "paused"):
                return False, "Campaign is already running or paused."

            self.recipients = recipients
            self.template = template
            self.smtp_config = smtp_config
            self.settings = settings
            self.total_emails = len(recipients)
            self.sent_count = 0
            self.failed_count = 0
            self.current_index = 0
            self.logs = []
            self.status = "running"
            self.stop_requested = False
            self.pause_requested = False

        self.log_event(f"Starting email campaign for {self.total_emails} recipients.")
        self.worker_thread = threading.Thread(target=self._run_campaign, daemon=True)
        self.worker_thread.start()
        return True, "Campaign started successfully."

    def pause(self):
        with self.lock:
            if self.status == "running":
                self.pause_requested = True
                self.status = "paused"
                self.log_event("Campaign paused by user.", "warning")
                self.broadcast_sse({"type": "status", "data": self.get_status_payload()})
                return True, "Campaign paused."
            return False, "Campaign is not currently running."

    def resume(self):
        with self.lock:
            if self.status == "paused":
                self.pause_requested = False
                self.status = "running"
                self.log_event("Campaign resumed by user.")
                self.broadcast_sse({"type": "status", "data": self.get_status_payload()})
                return True, "Campaign resumed."
            return False, "Campaign is not paused."

    def cancel(self):
        with self.lock:
            if self.status in ("running", "paused"):
                self.stop_requested = True
                self.status = "cancelled"
                self.log_event("Campaign cancellation requested by user.", "warning")
                self.broadcast_sse({"type": "status", "data": self.get_status_payload()})
                return True, "Campaign cancelling."
            return False, "No active campaign to cancel."

    def _format_template(self, text, recipient):
        if not text:
            return ""
        result = text
        for key, val in recipient.items():
            if isinstance(val, str):
                result = re.sub(r'\\{\\{\\s*' + re.escape(key) + r'\\s*\\}\\}', val, result)
                result = re.sub(r'\\{\\s*' + re.escape(key) + r'\\s*\\}', val, result)
        return result

    def _run_campaign(self):
        host = self.smtp_config.get("host")
        port = int(self.smtp_config.get("port", 587))
        user = self.smtp_config.get("username")
        password = self.smtp_config.get("password")
        from_email = self.smtp_config.get("from_email") or user
        from_name = self.smtp_config.get("from_name", "Campaign Sender")
        use_ssl = self.smtp_config.get("use_ssl", False)
        use_tls = self.smtp_config.get("use_tls", True)

        max_per_min = min(int(self.settings.get("max_per_minute", 30)), app.config.get("MAX_ALLOWED_EMAILS_PER_MINUTE", 300))
        delay_between_emails = max(60.0 / max_per_min if max_per_min > 0 else 1.0, 0.2)

        server = None

        def connect_smtp():
            nonlocal server
            if server:
                try:
                    server.quit()
                except Exception:
                    pass
            self.log_event(f"Connecting to SMTP server {host}:{port}...")
            if use_ssl:
                server = smtplib.SMTP_SSL(host, port, timeout=15)
            else:
                server = smtplib.SMTP(host, port, timeout=15)
                if use_tls:
                    server.starttls()
            if user and password:
                server.login(user, password)
            self.log_event("SMTP connection established successfully.")

        try:
            connect_smtp()
        except Exception as e:
            self.log_event(f"Failed to connect to SMTP server: {str(e)}", "error")
            with self.lock:
                self.status = "error"
            self.broadcast_sse({"type": "status", "data": self.get_status_payload()})
            return

        for idx, recipient in enumerate(self.recipients):
            if self.stop_requested:
                self.log_event("Campaign stopped before completion.", "warning")
                break

            while self.pause_requested and not self.stop_requested:
                time.sleep(0.5)

            if self.stop_requested:
                break

            self.current_index = idx + 1
            email = recipient.get("email", "").strip()

            try:
                valid_info = validate_email(email, check_deliverability=False)
                normalized_email = valid_info.normalized
            except EmailNotValidError as err:
                recipient["status"] = "failed"
                recipient["error"] = f"Invalid Email: {str(err)}"
                self.failed_count += 1
                self.log_event(f"[{idx+1}/{self.total_emails}] Skipped invalid email '{email}': {str(err)}", "error")
                self.broadcast_sse({"type": "progress", "data": self.get_status_payload()})
                continue

            subject = self._format_template(self.template.get("subject", ""), recipient)
            body_html = self._format_template(self.template.get("body_html", ""), recipient)
            body_text = self._format_template(self.template.get("body_text", ""), recipient)

            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = formataddr((from_name, from_email))
            msg["To"] = normalized_email

            if body_text:
                msg.attach(MIMEText(body_text, "plain", "utf-8"))
            if body_html:
                msg.attach(MIMEText(body_html, "html", "utf-8"))

            sent_successfully = False
            retries = 2
            for attempt in range(retries + 1):
                try:
                    server.send_message(msg)
                    sent_successfully = True
                    break
                except (smtplib.SMTPServerDisconnected, smtplib.SMTPResponseException, smtplib.SMTPConnectError) as smtp_err:
                    self.log_event(f"SMTP error sending to {normalized_email} (Attempt {attempt+1}): {str(smtp_err)}", "warning")
                    time.sleep(2)
                    try:
                        connect_smtp()
                    except Exception as re_err:
                        self.log_event(f"Re-connection failed: {str(re_err)}", "error")
                except Exception as send_err:
                    recipient["error"] = str(send_err)
                    break

            if sent_successfully:
                recipient["status"] = "sent"
                recipient["sent_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
                self.sent_count += 1
                self.log_event(f"[{idx+1}/{self.total_emails}] Successfully sent to {normalized_email}")
            else:
                recipient["status"] = "failed"
                if not recipient.get("error"):
                    recipient["error"] = "Failed after retry attempts."
                self.failed_count += 1
                self.log_event(f"[{idx+1}/{self.total_emails}] Failed to send to {normalized_email}: {recipient['error']}", "error")

            self.broadcast_sse({"type": "progress", "data": self.get_status_payload()})

            time.sleep(delay_between_emails)

        if server:
            try:
                server.quit()
            except Exception:
                pass

        with self.lock:
            if not self.stop_requested and self.status != "error":
                self.status = "completed"
                self.log_event(f"Campaign finished! Sent: {self.sent_count}, Failed: {self.failed_count}")

        self.broadcast_sse({"type": "status", "data": self.get_status_payload()})


campaign_engine = CampaignEngine()


# ==========================================
# FLASK ROUTES
# ==========================================

@app.route("/")
def index():
    return send_from_directory("public", "index.html")

@app.route("/public/<path:filename>")
def serve_public_assets(filename):
    return send_from_directory("public", filename)

@app.route("/api/smtp/verify", methods=["POST"])
def verify_smtp_connection():
    data = request.get_json() or {}
    host = data.get("host")
    port = int(data.get("port", 587))
    user = data.get("username")
    password = data.get("password")
    use_ssl = data.get("use_ssl", False)
    use_tls = data.get("use_tls", True)

    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            if use_tls:
                server.starttls()
        if user and password:
            server.login(user, password)
        server.quit()
        return jsonify({"success": True, "message": "SMTP Connection successful!"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/campaign/start", methods=["POST"])
def start_campaign():
    data = request.get_json() or {}
    success, msg = campaign_engine.start(
        data.get("recipients", []),
        data.get("template", {}),
        data.get("smtp", {}),
        data.get("settings", {})
    )
    if not success:
        return jsonify({"success": False, "error": msg}), 400
    return jsonify({"success": True, "message": msg})

@app.route("/api/campaign/stream", methods=["GET"])
def stream_campaign_progress():
    def event_stream():
        q = queue.Queue(maxsize=50)
        with campaign_engine.lock:
            campaign_engine.subscribers.append(q)
        yield f"data: {json.dumps({'type': 'init', 'data': campaign_engine.get_status_payload()})}\\n\\n"
        try:
            while True:
                yield q.get()
        except GeneratorExit:
            with campaign_engine.lock:
                if q in campaign_engine.subscribers:
                    campaign_engine.subscribers.remove(q)

    return Response(event_stream(), mimetype="text/event-stream")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
`
  },
  'config.py': {
    label: 'config.py',
    desc: 'Environment variable loader using python-dotenv with cPanel fallback defaults',
    lang: 'python',
    code: `"""
Configuration settings for the Bulk Email Campaign Manager.
Loads environment variables using python-dotenv.
"""

import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "default-dev-secret-change-in-production-12345")
    DEBUG = os.getenv("FLASK_DEBUG", "False").lower() in ("true", "1", "t")

    ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

    DEFAULT_MAX_EMAILS_PER_MINUTE = int(os.getenv("MAX_EMAILS_PER_MINUTE", 30))
    MAX_ALLOWED_EMAILS_PER_MINUTE = 300
    DEFAULT_BATCH_DELAY_SECONDS = float(os.getenv("BATCH_DELAY_SECONDS", 1.0))

    DEFAULT_SMTP_HOST = os.getenv("DEFAULT_SMTP_HOST", "")
    DEFAULT_SMTP_PORT = int(os.getenv("DEFAULT_SMTP_PORT", 587))
    DEFAULT_SMTP_USER = os.getenv("DEFAULT_SMTP_USER", "")
    DEFAULT_SMTP_PASS = os.getenv("DEFAULT_SMTP_PASS", "")

    CORS_ALLOWED_ORIGINS = os.getenv("CORS_ALLOWED_ORIGINS", "*")
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB max upload
`
  },
  'passenger_wsgi.py': {
    label: 'passenger_wsgi.py',
    desc: 'Phusion Passenger WSGI bootstrapper with cPanel virtualenv path resolution',
    lang: 'python',
    code: `"""
Passenger WSGI Entry Point for cPanel / CloudLinux Deployment.
Bridges Phusion Passenger with Flask, auto-detecting Python virtualenv site-packages.
"""

import sys
import os

INTERPRETER = sys.executable
APP_DIR = os.path.dirname(os.path.abspath(__file__))

if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

VENV_DIRS = [
    os.path.join(APP_DIR, "venv"),
    os.path.join(APP_DIR, "env"),
    os.path.join(APP_DIR, ".venv"),
]

HOME = os.path.expanduser("~")
CPANEL_VENV_BASE = os.path.join(HOME, "virtualenv")
if os.path.exists(CPANEL_VENV_BASE):
    for root, dirs, files in os.walk(CPANEL_VENV_BASE):
        if "site-packages" in root and root not in sys.path:
            sys.path.insert(0, root)

for venv in VENV_DIRS:
    site_packages_py = os.path.join(venv, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
    if os.path.exists(site_packages_py) and site_packages_py not in sys.path:
        sys.path.insert(0, site_packages_py)

try:
    from app import app as application
except Exception as e:
    def application(environ, start_response):
        status = '500 Internal Server Error'
        output = f"Passenger WSGI Startup Error: {str(e)}\\n".encode('utf-8')
        response_headers = [('Content-type', 'text/plain'), ('Content-Length', str(len(output)))]
        start_response(status, response_headers)
        return [output]
`
  },
  'requirements.txt': {
    label: 'requirements.txt',
    desc: 'Pinned Python packages for virtualenv installation on cPanel',
    lang: 'text',
    code: `Flask==3.0.3
Flask-Cors==4.0.1
Flask-HTTPAuth==4.8.0
python-dotenv==1.0.1
email-validator==2.1.1
gunicorn==22.0.0
`
  },
  '.env.example': {
    label: '.env.example',
    desc: 'Environment template for cPanel environment variables panel or local .env file',
    lang: 'ini',
    code: `# Flask & Campaign Server Configuration
FLASK_SECRET_KEY="generate_a_random_secret_key_here"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="secure_password_here"

# SMTP Server Defaults
DEFAULT_SMTP_HOST="mail.yourdomain.com"
DEFAULT_SMTP_PORT=587
DEFAULT_SMTP_USER="newsletter@yourdomain.com"
DEFAULT_SMTP_PASS="smtp_password_here"

# Throttle Limit (Emails per minute)
MAX_EMAILS_PER_MINUTE=30
LOG_LEVEL="INFO"
`
  }
};

export const CodeExplorerTab: React.FC = () => {
  const [activeFile, setActiveFile] = useState<string>('app.py');
  const [copied, setCopied] = useState<boolean>(false);

  const fileData = fileContents[activeFile];

  const handleCopy = () => {
    navigator.clipboard.writeText(fileData.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const element = document.createElement('a');
    const file = new Blob([fileData.code], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = activeFile;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-6">
          <div>
            <h2 className="text-xl font-bold text-slate-900 flex items-center">
              <FileCode className="w-5 h-5 text-blue-600 mr-2" /> Production-Ready Codebase Explorer
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Complete, corrected Python Flask & Passenger WSGI files ready for direct deployment to cPanel subdomains.
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold flex items-center transition border border-slate-300"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
              {copied ? 'Copied to Clipboard!' : 'Copy File'}
            </button>
            <button
              onClick={handleDownload}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold flex items-center transition shadow-sm"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" /> Download File
            </button>
          </div>
        </div>

        {/* File Tabs */}
        <div className="flex items-center space-x-2 border-b border-slate-200 overflow-x-auto pb-1 mb-4">
          {Object.keys(fileContents).map(fileName => (
            <button
              key={fileName}
              onClick={() => setActiveFile(fileName)}
              className={`px-4 py-2 font-mono text-xs rounded-t-lg font-bold transition flex items-center space-x-1.5 whitespace-nowrap ${
                activeFile === fileName
                  ? 'bg-slate-900 text-blue-400 border-t-2 border-blue-500'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>{fileName}</span>
            </button>
          ))}
        </div>

        {/* File Description */}
        <div className="bg-blue-50/60 border border-blue-100 rounded-lg p-3 text-xs text-blue-900 mb-4 flex items-center justify-between">
          <span><strong>Description:</strong> {fileData.desc}</span>
          <span className="font-mono text-[10px] bg-blue-200 text-blue-800 font-bold px-2 py-0.5 rounded uppercase">{fileData.lang}</span>
        </div>

        {/* Code Editor Frame */}
        <div className="relative rounded-xl overflow-hidden border border-slate-800 shadow-xl bg-slate-950">
          <div className="bg-slate-900 px-4 py-2 flex items-center justify-between border-b border-slate-800 text-xs font-mono text-slate-400">
            <div className="flex items-center space-x-2">
              <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block"></span>
              <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block"></span>
              <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block"></span>
              <span className="ml-2 font-bold text-slate-300">{activeFile}</span>
            </div>
            <span>UTF-8</span>
          </div>
          <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-[500px] leading-relaxed select-all">
            {fileData.code}
          </pre>
        </div>
      </div>
    </div>
  );
};
