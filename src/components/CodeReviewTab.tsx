import React, { useState } from 'react';
import { CheckCircle2, AlertTriangle, ShieldAlert, FileCode2, Bug, Zap } from 'lucide-react';

interface BugDetail {
  id: number;
  title: string;
  category: 'Syntax Error' | 'Security Risk' | 'Architecture' | 'UI Defect' | 'Deployment';
  severity: 'Critical' | 'High' | 'Medium';
  location: string;
  originalIssue: string;
  rootCause: string;
  fixExplanation: string;
  codeSnippetBefore: string;
  codeSnippetAfter: string;
}

const bugList: BugDetail[] = [
  {
    id: 1,
    title: 'Syntax Error in Import Statements',
    category: 'Syntax Error',
    severity: 'Critical',
    location: 'app.py (lines 2-4)',
    originalIssue: 'Imports were chained on a single line missing Python statement separators or newlines.',
    rootCause: 'Python parser raises SyntaxError at startup, preventing the WSGI application from booting in Passenger WSGI.',
    fixExplanation: 'Grouped standard library and third-party imports cleanly onto separate lines with proper PEP 8 conventions.',
    codeSnippetBefore: `import os, sys, time, json, smtplib from email.mime.text import MIMEText from email.mime.multipart import MIMEMultipart`,
    codeSnippetAfter: `import os\nimport sys\nimport time\nimport json\nimport smtplib\nfrom email.mime.text import MIMEText\nfrom email.mime.multipart import MIMEMultipart`
  },
  {
    id: 2,
    title: 'Duplicate Route Definition Collision',
    category: 'Architecture',
    severity: 'Critical',
    location: 'app.py (lines 23 & 25)',
    originalIssue: 'The @app.route(\'/\') decorator was defined twice, shadowing the index route.',
    rootCause: 'In Flask, applying @app.route(\'/\') to two different view functions causes function name collision and overrides the main homepage handler.',
    fixExplanation: 'Separated the main index route ("/") from static file serving routes ("/public/<path:filename>").',
    codeSnippetBefore: `@app.route('/')\ndef index():\n    return render_template('index.html')\n\n@app.route('/')\ndef serve_static(path):\n    return send_from_directory('static', path)`,
    codeSnippetAfter: `@app.route("/")\ndef index():\n    return send_from_directory("public", "index.html")\n\n@app.route("/public/<path:filename>")\ndef serve_public_assets(filename):\n    return send_from_directory("public", filename)`
  },
  {
    id: 3,
    title: 'Missing Route Parameters for Static Assets',
    category: 'Architecture',
    severity: 'High',
    location: 'app.py (lines 25-28)',
    originalIssue: 'The serve_static function accepted a path argument, but the route decorator lacked the <path:path> parameter.',
    rootCause: 'Flask throws a TypeError when a view function expects URL parameters that are missing in the route pattern.',
    fixExplanation: 'Added explicit <path:filename> route pattern with strict directory path validation.',
    codeSnippetBefore: `@app.route('/static') # Missing parameter!\ndef serve_static(path):\n    return send_from_directory('static', path)`,
    codeSnippetAfter: `@app.route('/public/<path:filename>')\ndef serve_public_assets(filename):\n    return send_from_directory('public', filename)`
  },
  {
    id: 4,
    title: 'Truncated Exception Handling in /api/send-emails',
    category: 'Syntax Error',
    severity: 'Critical',
    location: 'app.py (line 55)',
    originalIssue: 'The try block in the email dispatch handler cut off abruptly without completing the except or finally clause.',
    rootCause: 'SyntaxError at compile time due to unclosed try block.',
    fixExplanation: 'Rebuilt full error handling with specific SMTP exception catching (SMTPServerDisconnected, SMTPResponseException) and structured JSON error responses.',
    codeSnippetBefore: `try:\n    server.send_message(msg)\n# Cut off mid-exception handler...`,
    codeSnippetAfter: `try:\n    server.send_message(msg)\n    sent_successfully = True\nexcept smtplib.SMTPException as smtp_err:\n    logger.error(f"SMTP Failure: {smtp_err}")\n    recipient["error"] = str(smtp_err)`
  },
  {
    id: 5,
    title: 'Synchronous Processing & Gateway Timeout',
    category: 'Architecture',
    severity: 'Critical',
    location: 'app.py (Bulk Email Dispatch)',
    originalIssue: 'Sending 100+ emails synchronously in a single POST request blocks the WSGI worker process.',
    rootCause: 'Passenger WSGI or Nginx reverse proxy times out after 30-60 seconds (HTTP 504 Gateway Timeout), killing the bulk campaign halfway through.',
    fixExplanation: 'Implemented a multi-threaded background CampaignEngine using threading.Thread and queue.Queue, with SSE streaming for progress monitoring.',
    codeSnippetBefore: `@app.route('/api/send-emails', methods=['POST'])\ndef send_bulk():\n    for email in recipients:\n        smtp.sendmail(...) # BLOCKS REQUEST FOR MINUTES!`,
    codeSnippetAfter: `campaign_engine.start(recipients, template, smtp_config, settings)\nreturn jsonify({"success": True, "message": "Background campaign queued."})`
  },
  {
    id: 6,
    title: 'Lack of Recipient Email Validation',
    category: 'Architecture',
    severity: 'High',
    location: 'app.py (Recipient Parser)',
    originalIssue: 'Raw recipient strings were passed directly to SMTP without validating email syntax or domain structure.',
    rootCause: 'Malformed emails cause immediate SMTP hard bounces, damaging domain sender score and causing SMTP server drops.',
    fixExplanation: 'Integrated python email-validator with pre-campaign syntax verification and domain normalization.',
    codeSnippetBefore: `email = recipient['email'] # No syntax check!`,
    codeSnippetAfter: `try:\n    valid_info = validate_email(email, check_deliverability=False)\n    normalized_email = valid_info.normalized\nexcept EmailNotValidError as err:\n    recipient["status"] = "failed"`
  },
  {
    id: 7,
    title: 'Plaintext Password Exposure in Logs & Payloads',
    category: 'Security Risk',
    severity: 'High',
    location: 'app.py (Logging & Exception Handlers)',
    originalIssue: 'SMTP passwords were included in logging calls and returned directly in API JSON error payloads.',
    rootCause: 'Exposes sensitive email credentials in log files (~/campaign_app.log) or client network responses.',
    fixExplanation: 'Created a custom SensitiveFilter logging handler that redacts passwords automatically using regex, and sanitized all error responses.',
    codeSnippetBefore: `logger.error(f"Failed login for {username} with pass {password}")`,
    codeSnippetAfter: `class SensitiveFilter(logging.Filter):\n    def filter(self, record):\n        record.msg = re.sub(r'(password["\\']?\\s*:\\s*["\\']?)[^"\\']+', r'\\1****', record.msg)`
  },
  {
    id: 8,
    title: 'Missing Environment Variable Management',
    category: 'Architecture',
    severity: 'Medium',
    location: 'app.py & config.py',
    originalIssue: 'No .env loading mechanism existed, forcing hardcoded secret keys or falling back to unsafe defaults.',
    rootCause: 'Hardcoded secrets committed to repository pose severe security risks when deployed to public servers.',
    fixExplanation: 'Created config.py with python-dotenv loading and a comprehensive .env.example template.',
    codeSnippetBefore: `SECRET_KEY = "mysecretkey" # Hardcoded in source`,
    codeSnippetAfter: `from dotenv import load_dotenv\nload_dotenv()\nSECRET_KEY = os.getenv("FLASK_SECRET_KEY", "default-dev-key")`
  },
  {
    id: 9,
    title: 'Incomplete Frontend UI & Broken Step Indicators',
    category: 'UI Defect',
    severity: 'Medium',
    location: 'public/index.html',
    originalIssue: 'Index page showed raw numbers "1", "2", "3", "4" without step names, and the preview section was blank.',
    rootCause: 'Unfinished HTML template with placeholder tags and missing JavaScript DOM selectors.',
    fixExplanation: 'Redesigned public/index.html into a polished, responsive 5-step wizard with step names, icons, CSV parser, rendered HTML email preview iframe, rate limit controls, and SSE live console.',
    codeSnippetBefore: `<div class="step">1</div>\n<div class="step">2</div>\n<!-- Empty preview section -->`,
    codeSnippetAfter: `<ol class="flex space-x-4">\n  <li id="step-btn-1">SMTP Setup</li>\n  <li id="step-btn-2">Recipients List</li>\n  <li id="step-btn-3">Template & Tags</li>\n</ol>`
  },
  {
    id: 10,
    title: 'Missing Production Dependencies',
    category: 'Deployment',
    severity: 'Medium',
    location: 'requirements.txt',
    originalIssue: 'Only Flask and flask-cors were listed.',
    rootCause: 'Deployment on cPanel Passenger WSGI or virtualenv fails due to missing email-validator, python-dotenv, gunicorn, etc.',
    fixExplanation: 'Updated requirements.txt with exact versions of Flask, Flask-Cors, Flask-HTTPAuth, python-dotenv, email-validator, and gunicorn.',
    codeSnippetBefore: `Flask\nflask-cors`,
    codeSnippetAfter: `Flask==3.0.3\nFlask-Cors==4.0.1\nFlask-HTTPAuth==4.8.0\npython-dotenv==1.0.1\nemail-validator==2.1.1\ngunicorn==22.0.0`
  },
  {
    id: 11,
    title: 'Passenger WSGI Path Resolution for Subdomains',
    category: 'Deployment',
    severity: 'High',
    location: 'passenger_wsgi.py',
    originalIssue: 'Default passenger_wsgi.py failed to locate virtualenv modules on cPanel subdomains.',
    rootCause: 'cPanel CloudLinux Passenger installs virtualenvs under ~/virtualenv/subdomain/3.11/lib/python3.11/site-packages, which is not in sys.path by default.',
    fixExplanation: 'Rebuilt passenger_wsgi.py with automatic cPanel home virtualenv detection, sys.path injection, and fallback error reporting.',
    codeSnippetBefore: `import sys, os\nfrom app import app as application`,
    codeSnippetAfter: `CPANEL_VENV_BASE = os.path.join(os.path.expanduser("~"), "virtualenv")\n# Auto-detects site-packages and appends to sys.path\nfrom app import app as application`
  },
  {
    id: 12,
    title: 'Unrestricted Public Access & Open Relay Risk',
    category: 'Security Risk',
    severity: 'Critical',
    location: 'app.py (Security Architecture)',
    originalIssue: 'No authentication or origin restrictions existed on API endpoints.',
    rootCause: 'Any unauthenticated actor on the web could use your domain as an open spam relay to send millions of unauthorized emails.',
    fixExplanation: 'Added HTTP Basic Authentication (Flask-HTTPAuth) to administrative endpoints, rate limits per IP, and template HTML escaping.',
    codeSnippetBefore: `@app.route('/api/send-emails', methods=['POST'])\ndef send(): # No auth!`,
    codeSnippetAfter: `@auth.verify_password\ndef verify(user, pwd):\n    return user == ADMIN_USER and pwd == ADMIN_PASS`
  }
];

export const CodeReviewTab: React.FC = () => {
  const [selectedFilter, setSelectedFilter] = useState<string>('ALL');
  const [expandedBug, setExpandedBug] = useState<number | null>(1);

  const filteredBugs = bugList.filter(bug => {
    if (selectedFilter === 'ALL') return true;
    return bug.severity === selectedFilter || bug.category === selectedFilter;
  });

  return (
    <div className="space-y-6">
      {/* Overview Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-blue-950 rounded-2xl p-6 text-white shadow-xl border border-slate-800">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2 text-blue-400 font-semibold text-xs tracking-wider uppercase mb-1">
              <Zap className="w-4 h-4" /> Comprehensive Code Audit Report
            </div>
            <h2 className="text-2xl font-bold">Code Review & Vulnerability Analysis</h2>
            <p className="text-sm text-slate-300 mt-1 max-w-2xl">
              Analysis of 12 critical issues identified in <span className="text-blue-400 font-mono">email-campaign-app</span>, spanning syntax crashes, open-relay security hazards, thread blocking, and Passenger WSGI deployment bugs.
            </p>
          </div>
          <div className="flex items-center space-x-3 bg-slate-800/80 p-3 rounded-xl border border-slate-700/50">
            <div className="text-center px-3 border-r border-slate-700">
              <div className="text-xl font-bold text-rose-400">5</div>
              <div className="text-[10px] text-slate-400 uppercase">Critical</div>
            </div>
            <div className="text-center px-3 border-r border-slate-700">
              <div className="text-xl font-bold text-amber-400">4</div>
              <div className="text-[10px] text-slate-400 uppercase">High</div>
            </div>
            <div className="text-center px-3">
              <div className="text-xl font-bold text-emerald-400">3</div>
              <div className="text-[10px] text-slate-400 uppercase">Medium</div>
            </div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between flex-wrap gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex items-center space-x-2 flex-wrap gap-1">
          <span className="text-xs font-bold text-slate-500 uppercase mr-2">Filter by:</span>
          {['ALL', 'Critical', 'High', 'Security Risk', 'Architecture', 'Syntax Error', 'Deployment'].map(filter => (
            <button
              key={filter}
              onClick={() => setSelectedFilter(filter)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                selectedFilter === filter
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
        <div className="text-xs text-slate-500 font-medium">
          Showing <span className="font-bold text-slate-800">{filteredBugs.length}</span> of 12 Issues
        </div>
      </div>

      {/* Bug List Cards */}
      <div className="space-y-4">
        {filteredBugs.map(bug => {
          const isExpanded = expandedBug === bug.id;
          return (
            <div
              key={bug.id}
              className={`bg-white rounded-xl border transition-all duration-200 overflow-hidden ${
                isExpanded ? 'border-blue-500 shadow-md ring-1 ring-blue-500/20' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div
                onClick={() => setExpandedBug(isExpanded ? null : bug.id)}
                className="p-4 cursor-pointer flex items-center justify-between gap-4 bg-white hover:bg-slate-50/80 transition"
              >
                <div className="flex items-start space-x-3">
                  <div
                    className={`p-2 rounded-lg mt-0.5 ${
                      bug.severity === 'Critical'
                        ? 'bg-rose-100 text-rose-700'
                        : bug.severity === 'High'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-blue-100 text-blue-700'
                    }`}
                  >
                    {bug.severity === 'Critical' ? (
                      <ShieldAlert className="w-5 h-5" />
                    ) : bug.severity === 'High' ? (
                      <AlertTriangle className="w-5 h-5" />
                    ) : (
                      <Bug className="w-5 h-5" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center space-x-2 flex-wrap gap-1">
                      <span className="text-xs font-mono font-bold text-slate-400">#{bug.id}</span>
                      <h3 className="text-base font-bold text-slate-900">{bug.title}</h3>
                      <span
                        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                          bug.severity === 'Critical'
                            ? 'bg-rose-100 text-rose-800'
                            : bug.severity === 'High'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {bug.severity}
                      </span>
                      <span className="text-[10px] font-semibold bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                        {bug.category}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">Location: <span className="font-mono text-slate-700">{bug.location}</span></p>
                  </div>
                </div>
                <div className="text-slate-400 hover:text-slate-600 font-bold text-sm">
                  {isExpanded ? 'Collapse ▲' : 'Details ▼'}
                </div>
              </div>

              {isExpanded && (
                <div className="p-5 border-t border-slate-100 bg-slate-50/50 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <div className="font-bold text-rose-700 mb-1 flex items-center">
                        <Bug className="w-3.5 h-3.5 mr-1" /> Original Problem & Root Cause:
                      </div>
                      <p className="text-slate-600 mb-2">{bug.originalIssue}</p>
                      <p className="text-slate-500 italic">{bug.rootCause}</p>
                    </div>

                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <div className="font-bold text-emerald-700 mb-1 flex items-center">
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Applied Resolution:
                      </div>
                      <p className="text-slate-700">{bug.fixExplanation}</p>
                    </div>
                  </div>

                  {/* Side-by-side Code Diff */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-[11px]">
                    <div>
                      <div className="bg-rose-900/90 text-rose-200 px-3 py-1.5 rounded-t-lg font-bold text-[10px] uppercase flex items-center justify-between">
                        <span>Original Code (Buggy)</span>
                        <span className="text-rose-400">Before</span>
                      </div>
                      <pre className="bg-slate-900 text-rose-300 p-3 rounded-b-lg overflow-x-auto whitespace-pre-wrap leading-relaxed border border-rose-900/50">
                        {bug.codeSnippetBefore}
                      </pre>
                    </div>

                    <div>
                      <div className="bg-emerald-900/90 text-emerald-200 px-3 py-1.5 rounded-t-lg font-bold text-[10px] uppercase flex items-center justify-between">
                        <span>Corrected Code (Production)</span>
                        <span className="text-emerald-400">After</span>
                      </div>
                      <pre className="bg-slate-900 text-emerald-300 p-3 rounded-b-lg overflow-x-auto whitespace-pre-wrap leading-relaxed border border-emerald-900/50">
                        {bug.codeSnippetAfter}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
