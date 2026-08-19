import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, XCircle, ExternalLink, Terminal, Copy, Clock, Shield, Server } from 'lucide-react';

interface HealthData {
  status: string;
  service: string;
  timestamp: string;
  uptime_seconds?: number;
  require_login?: boolean;
  environment?: string;
  active_campaign?: {
    status: string;
    total: number;
    sent: number;
    failed: number;
  };
}

interface TestResult {
  name: string;
  endpoint: string;
  status: 'loading' | 'success' | 'warning' | 'error';
  statusCode?: number;
  latencyMs?: number;
  details?: string;
}

export function DiagnosticTab() {
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [rawLogs, setRawLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setRawLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 49)]);
  };

  const runDiagnostics = async () => {
    setLoading(true);
    addLog("Initiating full system diagnostic sweep...");

    const tests: TestResult[] = [
      { name: "Server Health Endpoint", endpoint: "/api/health", status: "loading" },
      { name: "Authentication Check", endpoint: "/api/auth/check", status: "loading" },
      { name: "Campaign Engine Status", endpoint: "/api/campaign/status", status: "loading" },
      { name: "Static HTML Assets", endpoint: "/campaign.html", status: "loading" },
    ];
    setTestResults(tests);

    // 1. Fetch /api/health
    const startHealth = performance.now();
    try {
      const res = await fetch('/api/health');
      const latency = Math.round(performance.now() - startHealth);
      if (res.ok) {
        const data: HealthData = await res.json();
        setHealthData(data);
        tests[0] = {
          name: "Server Health Endpoint",
          endpoint: "/api/health",
          status: "success",
          statusCode: res.status,
          latencyMs: latency,
          details: `Status: ${data.status} | Uptime: ${data.uptime_seconds || 0}s | Require Login: ${data.require_login}`
        };
        addLog(`SUCCESS: /api/health returned 200 OK (${latency}ms) - Status: ${data.status}`);
      } else {
        tests[0] = {
          name: "Server Health Endpoint",
          endpoint: "/api/health",
          status: "error",
          statusCode: res.status,
          latencyMs: latency,
          details: `HTTP ${res.status} ${res.statusText}`
        };
        addLog(`ERROR: /api/health returned HTTP ${res.status}`);
      }
    } catch (err: any) {
      tests[0] = {
        name: "Server Health Endpoint",
        endpoint: "/api/health",
        status: "error",
        details: `Network Error: ${err.message}`
      };
      addLog(`CRITICAL: Network error reaching /api/health - ${err.message}`);
    }

    // 2. Fetch /api/auth/check
    const startAuth = performance.now();
    try {
      const token = localStorage.getItem("edgevest_auth_token");
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch('/api/auth/check', { headers, credentials: 'include' });
      const latency = Math.round(performance.now() - startAuth);
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        tests[1] = {
          name: "Authentication Check",
          endpoint: "/api/auth/check",
          status: data.authenticated ? "success" : "warning",
          statusCode: res.status,
          latencyMs: latency,
          details: data.authenticated ? `Authenticated as "${data.username || 'admin'}"` : "Session unauthenticated (login required)"
        };
        addLog(`AUTH: /api/auth/check (${latency}ms) - Authenticated: ${data.authenticated}`);
      } else {
        tests[1] = {
          name: "Authentication Check",
          endpoint: "/api/auth/check",
          status: "warning",
          statusCode: res.status,
          latencyMs: latency,
          details: `HTTP ${res.status} - Login required`
        };
        addLog(`AUTH WARN: /api/auth/check returned HTTP ${res.status}`);
      }
    } catch (err: any) {
      tests[1] = {
        name: "Authentication Check",
        endpoint: "/api/auth/check",
        status: "error",
        details: `Network Error: ${err.message}`
      };
      addLog(`CRITICAL: Error checking auth route - ${err.message}`);
    }

    // 3. Fetch /api/campaign/status
    const startStatus = performance.now();
    try {
      const res = await fetch('/api/campaign/status', { credentials: 'include' });
      const latency = Math.round(performance.now() - startStatus);
      if (res.ok) {
        const data = await res.json();
        tests[2] = {
          name: "Campaign Engine Status",
          endpoint: "/api/campaign/status",
          status: "success",
          statusCode: res.status,
          latencyMs: latency,
          details: `Campaign State: "${data.status || 'idle'}" | Total: ${data.total || 0} | Sent: ${data.sent || 0}`
        };
        addLog(`CAMPAIGN: /api/campaign/status (${latency}ms) - State: ${data.status || 'idle'}`);
      } else {
        tests[2] = {
          name: "Campaign Engine Status",
          endpoint: "/api/campaign/status",
          status: res.status === 401 ? "warning" : "error",
          statusCode: res.status,
          latencyMs: latency,
          details: res.status === 401 ? "Auth required for campaign status" : `HTTP ${res.status}`
        };
        addLog(`CAMPAIGN WARN: /api/campaign/status returned HTTP ${res.status}`);
      }
    } catch (err: any) {
      tests[2] = {
        name: "Campaign Engine Status",
        endpoint: "/api/campaign/status",
        status: "error",
        details: `Network Error: ${err.message}`
      };
      addLog(`ERROR: Failed to query campaign status - ${err.message}`);
    }

    // 4. Check /campaign.html asset
    const startHtml = performance.now();
    try {
      const res = await fetch('/campaign.html', { method: 'HEAD' });
      const latency = Math.round(performance.now() - startHtml);
      tests[3] = {
        name: "Static HTML Assets",
        endpoint: "/campaign.html",
        status: res.ok ? "success" : "error",
        statusCode: res.status,
        latencyMs: latency,
        details: res.ok ? "campaign.html file accessible" : `HTTP ${res.status}`
      };
      addLog(`STATIC: /campaign.html HEAD check returned HTTP ${res.status} (${latency}ms)`);
    } catch (err: any) {
      tests[3] = {
        name: "Static HTML Assets",
        endpoint: "/campaign.html",
        status: "error",
        details: `Error loading campaign.html: ${err.message}`
      };
      addLog(`STATIC ERROR: campaign.html failed HEAD request - ${err.message}`);
    }

    setTestResults([...tests]);
    setLastUpdated(new Date().toLocaleTimeString());
    setLoading(false);
  };

  useEffect(() => {
    runDiagnostics();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      runDiagnostics();
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const copyLogText = () => {
    const text = rawLogs.join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatUptime = (sec?: number) => {
    if (!sec) return 'N/A';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 bg-[#16110d] border border-[#3d2d20] rounded-2xl shadow-xl">
        <div className="flex items-center space-x-3">
          <div className="p-3 bg-[#261c17] text-[#e2b871] rounded-xl border border-[#3d2d20]">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[#f7f4ee]">Server Diagnostic Console</h2>
            <p className="text-xs text-[#a8988a]">Real-time backend health monitor & route verification</p>
          </div>
        </div>

        <div className="flex items-center gap-3 w-full sm:w-auto">
          <label className="flex items-center space-x-2 text-xs text-[#d1c4b8] cursor-pointer bg-[#261c17] px-3 py-2 rounded-xl border border-[#3d2d20]">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-[#e2b871] rounded"
            />
            <span>Auto-poll (5s)</span>
          </label>

          <button
            onClick={runDiagnostics}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 bg-[#8c6543] hover:bg-[#9e7854] text-white text-xs font-semibold rounded-xl border border-[#c5a059]/40 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Testing...' : 'Refresh Diagnostics'}</span>
          </button>
        </div>
      </div>

      {/* Overview Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Server Status */}
        <div className="p-4 bg-[#16110d] border border-[#3d2d20] rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs text-[#a8988a]">
            <span>Server Health</span>
            <Server className="w-4 h-4 text-[#e2b871]" />
          </div>
          <div className="flex items-center space-x-2">
            <span className={`w-3 h-3 rounded-full ${healthData?.status === 'online' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
            <span className="text-base font-bold text-white uppercase">{healthData?.status || 'UNKNOWN'}</span>
          </div>
          <p className="text-[11px] text-[#a8988a] truncate">{healthData?.service || 'Express Server'}</p>
        </div>

        {/* Uptime */}
        <div className="p-4 bg-[#16110d] border border-[#3d2d20] rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs text-[#a8988a]">
            <span>System Uptime</span>
            <Clock className="w-4 h-4 text-[#e2b871]" />
          </div>
          <div className="text-base font-bold text-white font-mono">
            {formatUptime(healthData?.uptime_seconds)}
          </div>
          <p className="text-[11px] text-[#a8988a]">Last sweep: {lastUpdated || 'Just now'}</p>
        </div>

        {/* Security Flag */}
        <div className="p-4 bg-[#16110d] border border-[#3d2d20] rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs text-[#a8988a]">
            <span>Require Login</span>
            <Shield className="w-4 h-4 text-[#e2b871]" />
          </div>
          <div className="text-base font-bold text-white">
            {healthData?.require_login ? (
              <span className="text-amber-400">ENFORCED (True)</span>
            ) : (
              <span className="text-emerald-400">DISABLED (False)</span>
            )}
          </div>
          <p className="text-[11px] text-[#a8988a]">Env: {healthData?.environment || 'development'}</p>
        </div>

        {/* Active Campaign */}
        <div className="p-4 bg-[#16110d] border border-[#3d2d20] rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs text-[#a8988a]">
            <span>Active Campaign</span>
            <Activity className="w-4 h-4 text-[#e2b871]" />
          </div>
          <div className="text-base font-bold text-white uppercase font-mono">
            {healthData?.active_campaign?.status || 'IDLE'}
          </div>
          <p className="text-[11px] text-[#a8988a]">
            {healthData?.active_campaign?.sent || 0} / {healthData?.active_campaign?.total || 0} Sent
          </p>
        </div>
      </div>

      {/* Endpoint Test Results */}
      <div className="p-5 bg-[#16110d] border border-[#3d2d20] rounded-2xl space-y-4">
        <h3 className="text-sm font-bold text-[#f7f4ee] flex items-center">
          <Server className="w-4 h-4 mr-2 text-[#e2b871]" /> Endpoint Diagnostics Sweep
        </h3>

        <div className="space-y-2.5">
          {testResults.map((test, idx) => (
            <div
              key={idx}
              className="p-3.5 bg-[#0d0b0a] border border-[#261c17] rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
            >
              <div className="flex items-center space-x-3">
                {test.status === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                {test.status === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />}
                {test.status === 'error' && <XCircle className="w-4 h-4 text-rose-400 shrink-0" />}
                {test.status === 'loading' && <RefreshCw className="w-4 h-4 text-sky-400 animate-spin shrink-0" />}

                <div>
                  <div className="font-semibold text-stone-200">{test.name}</div>
                  <div className="text-[11px] font-mono text-[#a8988a]">{test.endpoint}</div>
                </div>
              </div>

              <div className="flex items-center gap-3 self-end sm:self-auto">
                {test.latencyMs !== undefined && (
                  <span className="font-mono text-[11px] text-stone-400 px-2 py-0.5 bg-[#1a1410] rounded border border-[#3d2d20]">
                    {test.latencyMs}ms
                  </span>
                )}
                {test.statusCode !== undefined && (
                  <span className={`font-mono text-[11px] px-2 py-0.5 rounded border ${
                    test.statusCode === 200 ? 'bg-emerald-950/60 border-emerald-800/80 text-emerald-300' : 'bg-amber-950/60 border-amber-800/80 text-amber-300'
                  }`}>
                    HTTP {test.statusCode}
                  </span>
                )}
                <span className="text-[11px] text-stone-300 max-w-xs truncate">{test.details || ''}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Launch & Diagnostic Console */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Direct App Launch Links */}
        <div className="p-5 bg-[#16110d] border border-[#3d2d20] rounded-2xl space-y-4">
          <h3 className="text-sm font-bold text-[#f7f4ee] flex items-center">
            <ExternalLink className="w-4 h-4 mr-2 text-[#e2b871]" /> Direct App Launch & Bypass Controls
          </h3>

          <p className="text-xs text-[#a8988a] leading-relaxed">
            If iframe embedding is restricted by preview sandbox policies, use these direct links to open the application routes directly in your window or a new tab.
          </p>

          <div className="space-y-2 pt-2">
            <a
              href="/campaign.html"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between p-3 bg-[#261c17] hover:bg-[#32241d] border border-[#3d2d20] hover:border-[#8c6543] rounded-xl text-xs text-[#f7f4ee] font-semibold transition"
            >
              <span className="flex items-center">
                <ExternalLink className="w-4 h-4 mr-2 text-[#e2b871]" /> Open Campaign Dashboard in New Tab
              </span>
              <span className="font-mono text-[11px] text-[#a8988a]">/campaign.html</span>
            </a>

            <a
              href="/login"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between p-3 bg-[#261c17] hover:bg-[#32241d] border border-[#3d2d20] hover:border-[#8c6543] rounded-xl text-xs text-[#f7f4ee] font-semibold transition"
            >
              <span className="flex items-center">
                <ExternalLink className="w-4 h-4 mr-2 text-[#e2b871]" /> Open Login Screen in New Tab
              </span>
              <span className="font-mono text-[11px] text-[#a8988a]">/login</span>
            </a>

            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between p-3 bg-[#261c17] hover:bg-[#32241d] border border-[#3d2d20] hover:border-[#8c6543] rounded-xl text-xs text-[#f7f4ee] font-semibold transition"
            >
              <span className="flex items-center">
                <Terminal className="w-4 h-4 mr-2 text-[#e2b871]" /> View Raw /api/health JSON Response
              </span>
              <span className="font-mono text-[11px] text-[#a8988a]">/api/health</span>
            </a>
          </div>
        </div>

        {/* Realtime Diagnostic Logs */}
        <div className="p-5 bg-[#16110d] border border-[#3d2d20] rounded-2xl space-y-4 flex flex-col">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[#f7f4ee] flex items-center">
              <Terminal className="w-4 h-4 mr-2 text-[#e2b871]" /> Diagnostic Stream Console
            </h3>

            <button
              onClick={copyLogText}
              className="flex items-center space-x-1.5 px-2.5 py-1 bg-[#261c17] hover:bg-[#32241d] border border-[#3d2d20] text-xs text-[#d1c4b8] rounded-lg transition"
            >
              <Copy className="w-3 h-3 text-[#e2b871]" />
              <span>{copied ? 'Copied!' : 'Copy Logs'}</span>
            </button>
          </div>

          <div className="p-3 bg-[#0a0806] border border-[#261c17] rounded-xl font-mono text-xs max-h-56 overflow-y-auto space-y-1 text-stone-300 flex-1">
            {rawLogs.length === 0 ? (
              <div className="text-stone-500 italic py-4 text-center">No diagnostic logs recorded yet.</div>
            ) : (
              rawLogs.map((log, i) => (
                <div key={i} className={
                  log.includes('CRITICAL') || log.includes('ERROR') ? 'text-rose-400 font-semibold' :
                  log.includes('SUCCESS') ? 'text-emerald-400' :
                  log.includes('WARN') ? 'text-amber-400' : 'text-stone-300'
                }>
                  {log}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
