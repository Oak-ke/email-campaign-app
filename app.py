from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import csv
import io
import os

app = Flask(__name__)

# Configure static folder - try multiple possible locations
static_folders = ['frontend', './frontend', 'static', './static']

for folder in static_folders:
    if os.path.exists(folder):
        app.static_folder = folder
        app.static_url_path = ''
        print(f"Using static folder: {folder}")
        break
else:
    print("Warning: No static folder found")

CORS(app)

# Serve the main page
@app.route('/')
def serve_index():
    try:
        return send_from_directory(app.static_folder, 'index.html')
    except:
        return "Email Campaign App is running! But frontend files are missing."

# Serve other frontend files (CSS, JS, etc.)
@app.route('/<path:path>')
def serve_static(path):
    if path.startswith('api/'):
        return app.response_class(status=404)
    
    try:
        return send_from_directory(app.static_folder, path)
    except:
        try:
            # Try to serve index.html for client-side routing
            return send_from_directory(app.static_folder, 'index.html')
        except:
            return f"File {path} not found", 404

# Your existing API routes (keep all your existing routes exactly as they were)
@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    data = request.json
    try:
        with smtplib.SMTP_SSL(data['smtp_server'], int(data['smtp_port'])) as server:
            server.login(data['sender_email'], data['password'])
        return jsonify({"status": "success", "message": "SMTP connection successful!"})
    except Exception as e:
        return jsonify({"status": "error", "message": f"Connection failed: {str(e)}"})

@app.route('/api/send-emails', methods=['POST'])
def send_emails():
    try:
        data = request.json
        smtp_config = data['smtp_config']
        recipients = data['recipients']
        subject_template = data['subject_template']
        body_template = data['body_template']
        
        results = []
        sent_count = 0
        
        # Connect to SMTP server once
        with smtplib.SMTP_SSL(smtp_config['smtp_server'], int(smtp_config['smtp_port'])) as server:
            server.login(smtp_config['sender_email'], smtp_config['password'])
            
            for i, recipient in enumerate(recipients):
                try:
                    recipient_email = recipient.get('Email', '').strip()
                    if not recipient_email:
                        results.append(f"Recipient {i+1}: No email address found")
                        continue
                    
                    # Personalize subject and body
                    subject = subject_template.format(**recipient)
                    body = body_template.format(**recipient)
                    
                    # Create message
                    msg = MIMEMultipart()
                    msg['From'] = smtp_config['sender_email']
                    msg['To'] = recipient_email
                    msg['Subject'] = subject
                    msg.attach(MIMEText(body, 'html'))
                    
                    # Send email
                    server.sendmail(smtp_config['sender_email'], recipient_email, msg.as_string())
                    sent_count += 1
                    results.append(f"Email {i+1}: Successfully sent to {recipient_email}")
                    
                except Exception as e:
                    results.append(f"Email {i+1}: Failed to send - {str(e)}")
        
        return jsonify({
            "status": "success", 
            "message": f"Processed {len(recipients)} recipients. Successfully sent {sent_count} emails.",
            "results": results
        })
        
    except Exception as e:
        return jsonify({"status": "error", "message": f"Server error: {str(e)}"})

@app.route('/api/parse-csv', methods=['POST'])
def parse_csv():
    try:
        if 'file' not in request.files:
            return jsonify({"status": "error", "message": "No file uploaded"})
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({"status": "error", "message": "No file selected"})
        
        if not file.filename.endswith('.csv'):
            return jsonify({"status": "error", "message": "Please upload a CSV file"})
        
        # Read and parse CSV
        stream = io.StringIO(file.stream.read().decode("UTF8"), newline=None)
        csv_input = csv.reader(stream)
        
        # Get headers
        headers = [header.strip() for header in next(csv_input)]
        
        # Get data rows
        recipients = []
        for row in csv_input:
            if row and any(field.strip() for field in row):  # Skip empty rows
                recipient = {}
                for i, header in enumerate(headers):
                    recipient[header] = row[i].strip() if i < len(row) else ""
                recipients.append(recipient)
        
        return jsonify({
            "status": "success", 
            "message": f"Successfully parsed {len(recipients)} recipients",
            "recipients": recipients,
            "headers": headers
        })
        
    except Exception as e:
        return jsonify({"status": "error", "message": f"Error parsing CSV: {str(e)}"})

@app.route('/health')
def health_check():
    return jsonify({"status": "healthy", "message": "Server is running"})

@app.route('/api/debug')
def debug_info():
    return jsonify({
        "static_folder": app.static_folder,
        "static_url_path": app.static_url_path,
        "files_in_static": os.listdir(app.static_folder) if app.static_folder and os.path.exists(app.static_folder) else "No static folder"
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 10000))
    app.run(host='0.0.0.0', port=port, debug=False)