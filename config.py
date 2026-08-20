"""
Configuration settings for the Bulk Email Campaign Manager.
Loads environment variables using python-dotenv.
"""

import os
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

class Config:
    # Flask settings
    SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "default-dev-secret-change-in-production-12345")
    DEBUG = os.getenv("FLASK_DEBUG", "False").lower() in ("true", "1", "t")

    # Authentication settings
    ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

    # Campaign Throttle & Rate Limits
    DEFAULT_MAX_EMAILS_PER_MINUTE = int(os.getenv("MAX_EMAILS_PER_MINUTE", 30))
    MAX_ALLOWED_EMAILS_PER_MINUTE = 300  # Cap to protect SMTP reputation
    DEFAULT_BATCH_DELAY_SECONDS = float(os.getenv("BATCH_DELAY_SECONDS", 1.0))

    # SMTP Default Credentials (Optional defaults from env)
    DEFAULT_SMTP_HOST = os.getenv("DEFAULT_SMTP_HOST", "")
    DEFAULT_SMTP_PORT = int(os.getenv("DEFAULT_SMTP_PORT", 587))
    DEFAULT_SMTP_USER = os.getenv("DEFAULT_SMTP_USER", "")
    DEFAULT_SMTP_PASS = os.getenv("DEFAULT_SMTP_PASS", "")

    # Security & CORS
    CORS_ALLOWED_ORIGINS = os.getenv("CORS_ALLOWED_ORIGINS", "*")
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB max upload limit
