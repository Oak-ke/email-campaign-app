import React from 'react';
import { Server, ShieldCheck } from 'lucide-react';

export const DeploymentGuideTab: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-blue-900 via-slate-900 to-indigo-950 rounded-2xl p-6 text-white shadow-xl border border-blue-900/50">
        <div className="flex items-center space-x-3 text-blue-400 font-semibold text-xs uppercase tracking-wider mb-2">
          <Server className="w-4 h-4" /> cPanel & CloudLinux Deployment Guide
        </div>
        <h2 className="text-2xl font-bold">Subdomain Deployment with Passenger WSGI</h2>
        <p className="text-sm text-slate-300 mt-1 max-w-3xl">
          Step-by-step instructions for deploying this Python Flask Bulk Email Campaign Manager to a cPanel subdomain using Phusion Passenger WSGI.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Step 1 */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-sm">1</div>
            <h3 className="font-bold text-slate-900 text-base">Create Subdomain in cPanel</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Navigate to <strong>cPanel &gt; Domains &gt; Subdomains</strong> and create a subdomain (e.g., <code className="bg-slate-100 px-1 py-0.5 rounded text-blue-700">email.yourdomain.com</code>). Set Document Root to <code className="bg-slate-100 px-1 py-0.5 rounded">/public_html/email</code> or <code className="bg-slate-100 px-1 py-0.5 rounded">/email.yourdomain.com</code>.
          </p>
        </div>

        {/* Step 2 */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-sm">2</div>
            <h3 className="font-bold text-slate-900 text-base">Setup Python App in cPanel</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Go to <strong>cPanel &gt; Software &gt; Setup Python App</strong>:
          </p>
          <ul className="text-xs text-slate-600 space-y-1 list-disc list-inside bg-slate-50 p-3 rounded-lg border border-slate-100 font-mono">
            <li>Python Version: 3.10+ or 3.11</li>
            <li>Application Root: <span className="text-blue-600">email.yourdomain.com</span></li>
            <li>Application URL: <span className="text-blue-600">email.yourdomain.com</span></li>
            <li>Application Startup File: <span className="text-emerald-600">passenger_wsgi.py</span></li>
            <li>Application Entry Point: <span className="text-emerald-600">application</span></li>
          </ul>
        </div>

        {/* Step 3 */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-sm">3</div>
            <h3 className="font-bold text-slate-900 text-base">Upload Project Files</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Upload the corrected files directly into your subdomain folder using cPanel File Manager or FTP:
          </p>
          <div className="bg-slate-900 text-slate-200 p-3 rounded-lg font-mono text-[11px] space-y-1">
            <div className="text-blue-400 font-bold">/home/username/email.yourdomain.com/</div>
            <div className="pl-4">├── app.py</div>
            <div className="pl-4">├── config.py</div>
            <div className="pl-4">├── passenger_wsgi.py</div>
            <div className="pl-4">├── requirements.txt</div>
            <div className="pl-4">├── .env</div>
            <div className="pl-4">└── public/</div>
            <div className="pl-8 text-slate-400">└── index.html</div>
          </div>
        </div>

        {/* Step 4 */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-3">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-sm">4</div>
            <h3 className="font-bold text-slate-900 text-base">Install Virtualenv Dependencies</h3>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Copy the virtual environment activation command from top of <strong>Setup Python App</strong> page, run via cPanel Terminal or SSH:
          </p>
          <div className="bg-slate-900 text-emerald-400 p-3 rounded-lg font-mono text-xs overflow-x-auto">
            source /home/username/virtualenv/email.yourdomain.com/3.11/bin/activate<br/>
            pip install -r requirements.txt
          </div>
        </div>
      </div>

      {/* Common Passenger WSGI Pitfalls & Fixes */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-4">
        <h3 className="text-base font-bold text-slate-900 flex items-center">
          <ShieldCheck className="w-5 h-5 text-emerald-600 mr-2" /> Key Passenger WSGI Troubleshooting & Performance Rules
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="font-bold text-slate-900 mb-1">1. Restarting App After Edits</div>
            <p className="text-slate-600">
              Phusion Passenger caches Python files in memory. After modifying <code className="text-blue-600 font-mono">app.py</code>, click "Restart Application" in cPanel or touch <code className="text-blue-600 font-mono">tmp/restart.txt</code>.
            </p>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="font-bold text-slate-900 mb-1">2. Disabling Nginx Buffering for SSE</div>
            <p className="text-slate-600">
              For real-time SSE progress updates (<code className="text-blue-600 font-mono">/api/campaign/stream</code>), ensure header <code className="text-emerald-600 font-mono">X-Accel-Buffering: no</code> is sent.
            </p>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
            <div className="font-bold text-slate-900 mb-1">3. File Permissions</div>
            <p className="text-slate-600">
              Set file permissions to <code className="font-mono font-bold text-slate-800">0644</code> for Python files and <code className="font-mono font-bold text-slate-800">0755</code> for directories. Avoid <code className="font-mono text-rose-600">0777</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
