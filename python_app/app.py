"""
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
from email.mime.image import MIMEImage
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
            # Redact password patterns
            record.msg = re.sub(r'(password["\']?\s*:\s*["\']?)[^"\']+', r'\1****', record.msg, flags=re.IGNORECASE)
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
        self.subscribers = []  # SSE queue listeners
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
        data_str = f"data: {json.dumps(data)}\n\n"
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
        # Replace common merge tags: {email}, {name}, {company}, etc.
        for key, val in recipient.items():
            if isinstance(val, str):
                result = re.sub(r'\{\{\s*' + re.escape(key) + r'\s*\}\}', val, result)
                result = re.sub(r'\{\s*' + re.escape(key) + r'\s*\}', val, result)
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

            # Email Validation
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

            # Prepare Message with CID Embedded Logo Support
            subject = self._format_template(self.template.get("subject", ""), recipient)
            body_html = self._format_template(self.template.get("body_html", ""), recipient)
            body_text = self._format_template(self.template.get("body_text", ""), recipient)

            msg = MIMEMultipart("related")
            msg["Subject"] = subject
            msg["From"] = formataddr((from_name, from_email))
            msg["To"] = normalized_email

            msg_alt = MIMEMultipart("alternative")
            if body_text:
                msg_alt.attach(MIMEText(body_text, "plain", "utf-8"))
            if body_html:
                msg_alt.attach(MIMEText(body_html, "html", "utf-8"))
            msg.attach(msg_alt)

            # Attach inline CID emblem image
            emblem_path = os.path.join(os.path.dirname(__file__), "public", "edgevest_emblem.jpg")
            if not os.path.exists(emblem_path):
                emblem_path = os.path.join(os.path.dirname(__file__), "..", "assets", "edgevest_emblem.jpg")
            if os.path.exists(emblem_path):
                try:
                    with open(emblem_path, "rb") as img_f:
                        img_data = img_f.read()
                        img_mime = MIMEImage(img_data)
                        img_mime.add_header("Content-ID", "<edgevest_emblem>")
                        img_mime.add_header("Content-Disposition", "inline", filename="edgevest_emblem.jpg")
                        msg.attach(img_mime)
                except Exception as img_err:
                    pass

            # Send Email with Retry Logic
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

            # Throttle Delay
            time.sleep(delay_between_emails)

        # Close SMTP Server
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


# Singleton Engine Instance
campaign_engine = CampaignEngine()


# ==========================================
# FLASK ROUTES & API ENDPOINTS
# ==========================================

@app.route("/")
def index():
    """Serves the main single page web app UI"""
    return send_from_directory("public", "index.html")


@app.route("/public/<path:filename>")
def serve_public_assets(filename):
    """Static file router for public assets"""
    return send_from_directory("public", filename)


@app.route("/api/health", methods=["GET"])
def health_check():
    """Health check endpoint"""
    return jsonify({
        "status": "online",
        "service": "Bulk Email Campaign Manager",
        "timestamp": time.time()
    })


@app.route("/api/smtp/verify", methods=["POST"])
def verify_smtp_connection():
    """Tests SMTP credentials without sending emails"""
    data = request.get_json() or {}
    host = data.get("host")
    port = int(data.get("port", 587))
    user = data.get("username")
    password = data.get("password")
    use_ssl = data.get("use_ssl", False)
    use_tls = data.get("use_tls", True)

    if not host or not port:
        return jsonify({"success": False, "error": "SMTP Host and Port are required."}), 400

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
        return jsonify({"success": True, "message": "SMTP Connection test successful!"})
    except Exception as e:
        logger.error(f"SMTP Verification Error: {str(e)}")
        return jsonify({"success": False, "error": f"SMTP Connection Failed: {str(e)}"}), 400


@app.route("/api/recipients/validate", methods=["POST"])
def validate_recipient_list():
    """Validates list of recipients and returns clean list + syntax errors"""
    data = request.get_json() or {}
    raw_recipients = data.get("recipients", [])

    valid_list = []
    invalid_list = []

    for r in raw_recipients:
        email = r.get("email", "").strip() if isinstance(r, dict) else str(r).strip()
        name = r.get("name", "") if isinstance(r, dict) else ""

        if not email:
            continue

        try:
            valid_info = validate_email(email, check_deliverability=False)
            item = r if isinstance(r, dict) else {"email": valid_info.normalized, "name": name}
            item["email"] = valid_info.normalized
            item["status"] = "valid"
            valid_list.append(item)
        except EmailNotValidError as err:
            invalid_list.append({
                "email": email,
                "name": name,
                "error": str(err)
            })

    return jsonify({
        "total_submitted": len(raw_recipients),
        "valid_count": len(valid_list),
        "invalid_count": len(invalid_list),
        "valid_recipients": valid_list,
        "invalid_recipients": invalid_list
    })


@app.route("/api/campaign/start", methods=["POST"])
def start_campaign():
    """Launches the bulk email campaign background queue"""
    data = request.get_json() or {}

    recipients = data.get("recipients", [])
    template = data.get("template", {})
    smtp_config = data.get("smtp", {})
    settings = data.get("settings", {})

    if not recipients or len(recipients) == 0:
        return jsonify({"success": False, "error": "Recipient list cannot be empty."}), 400

    if not template.get("subject") or not (template.get("body_html") or template.get("body_text")):
        return jsonify({"success": False, "error": "Email template subject and content are required."}), 400

    if not smtp_config.get("host"):
        return jsonify({"success": False, "error": "SMTP server host is required."}), 400

    success, msg = campaign_engine.start(recipients, template, smtp_config, settings)
    if not success:
        return jsonify({"success": False, "error": msg}), 400

    return jsonify({"success": True, "message": msg, "total": len(recipients)})


@app.route("/api/campaign/pause", methods=["POST"])
def pause_campaign():
    """Pauses active campaign"""
    success, msg = campaign_engine.pause()
    return jsonify({"success": success, "message": msg})


@app.route("/api/campaign/resume", methods=["POST"])
def resume_campaign():
    """Resumes paused campaign"""
    success, msg = campaign_engine.resume()
    return jsonify({"success": success, "message": msg})


@app.route("/api/campaign/cancel", methods=["POST"])
def cancel_campaign():
    """Cancels running campaign"""
    success, msg = campaign_engine.cancel()
    return jsonify({"success": success, "message": msg})


@app.route("/api/campaign/status", methods=["GET"])
def get_campaign_status():
    """Polls current campaign progress & logs"""
    return jsonify(campaign_engine.get_status_payload())


@app.route("/api/campaign/stream", methods=["GET"])
def stream_campaign_progress():
    """Server-Sent Events (SSE) stream for live real-time campaign progress"""
    def event_stream():
        q = queue.Queue(maxsize=50)
        with campaign_engine.lock:
            campaign_engine.subscribers.append(q)

        # Initial status broadcast
        init_data = f"data: {json.dumps({'type': 'init', 'data': campaign_engine.get_status_payload()})}\n\n"
        yield init_data

        try:
            while True:
                msg = q.get()
                yield msg
        except GeneratorExit:
            with campaign_engine.lock:
                if q in campaign_engine.subscribers:
                    campaign_engine.subscribers.remove(q)

    return Response(event_stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no"  # Disable proxy buffering for cPanel Nginx
    })


@app.route("/api/campaign/export-report", methods=["GET"])
def export_campaign_report():
    """Exports CSV report of sent/failed recipients"""
    status_data = campaign_engine.get_status_payload()
    recipients = campaign_engine.recipients

    output = "Email,Name,Status,Error,SentAt\n"
    for r in recipients:
        email = r.get("email", "").replace(",", "")
        name = r.get("name", "").replace(",", "")
        st = r.get("status", "pending")
        err = r.get("error", "").replace(",", ";")
        sent_at = r.get("sent_at", "")
        output += f"{email},{name},{st},{err},{sent_at}\n"

    return Response(
        output,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=campaign_report.csv"}
    )


# Error Handlers
@app.errorhandler(404)
def not_found(e):
    return send_from_directory("public", "index.html")


@app.errorhandler(500)
def server_error(e):
    logger.error(f"Internal Server Error: {str(e)}")
    return jsonify({"error": "Internal Server Error", "details": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=app.config["DEBUG"])
