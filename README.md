# Email Campaign Manager

A modern web application built with Flask for sending personalized email campaigns to multiple recipients. Upload CSV files with recipient data, create customized email templates, and send emails through any SMTP server.

Features

- CSV Integration: Upload recipient lists with custom fields
- Personalized Templates: Use variables like `{Name}`, `{Email}`, `{Company}` in subjects and bodies
- SMTP Support: Connect to any email service (Gmail, Outlook, etc.)
- Real-time Progress: Track email sending with live updates
- Responsive Design: Works on desktop and mobile devices
- Email Preview: Test your templates before sending
- Branded Emails: Automatic Edgevest header and footer

Tech Stack

- Backend: Flask, Python
- Frontend: HTML5, CSS3, JavaScript
- Email: SMTP with SSL/TLS support
- Deployment: Render.com

Quick Start

Prerequisites
- Python 3.6+
- Git

Installation

1. Clonthe repository
   ```bash
   git clone https://github.com/Oak-ke/email-campaign-app.git
   cd email-campaign-app

2. Install dependencies
   pip install -r requirements.txt

3. Run the application
   python app.py

4. Access the application
   Open your browser and go to: http://localhost:10000


Project Structure
email-campaign-app/
├── app.py                 # Flask backend
├── requirements.txt       # Python dependencies
├── runtime.txt           # Python version
├── README.md             # This file
└── frontend/
    └── index.html        # Web interface

Live Demo   
Deployed on Render: https://email-campaign-app.onrender.com