"""
Passenger WSGI Entry Point for cPanel / CloudLinux Deployment.

This file bridges Phusion Passenger with the Flask WSGI application instance.
It handles automatic Python virtualenv path resolution on cPanel shared hosting.
"""

import sys
import os

# Determine directory where passenger_wsgi.py is located
INTERPRETER = sys.executable
APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Ensure current application directory is in Python path
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

# Auto-detect virtualenv in common cPanel paths or local folder
VENV_DIRS = [
    os.path.join(APP_DIR, "venv"),
    os.path.join(APP_DIR, "env"),
    os.path.join(APP_DIR, ".venv"),
]

# Check cPanel home directory virtualenvs (~/virtualenv/subdomain/3.11/lib/python3.11/site-packages)
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

# Import the Flask application
try:
    from app import app as application
except Exception as e:
    # Fallback error reporter if WSGI fails to boot
    def application(environ, start_response):
        status = '500 Internal Server Error'
        output = f"Passenger WSGI Startup Error: {str(e)}\n".encode('utf-8')
        response_headers = [('Content-type', 'text/plain'), ('Content-Length', str(len(output)))]
        start_response(status, response_headers)
        return [output]
