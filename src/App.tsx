import React, { useState, useEffect } from 'react';
import { Send, Terminal } from 'lucide-react';
import { CodeReviewTab } from './components/CodeReviewTab';
import { CodeExplorerTab } from './components/CodeExplorerTab';
import { DeploymentGuideTab } from './components/DeploymentGuideTab';

export default function App() {
  const [showDevTools, setShowDevTools] = useState(false);
  const [devTab, setDevTab] = useState<'review' | 'code' | 'guide'>('review');

  useEffect(() => {
    // Check if ?dev=true is in URL query parameters
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === 'true') {
      setShowDevTools(true);
    }
  }, []);

  return (
    <div className="min-h-screen bg-[#0d0b0a] text-[#f7f4ee] font-sans antialiased flex flex-col">
      {/* Hidden Dev Mode Bar (Only visible if ?dev=true or toggled by administrator) */}
      {showDevTools && (
        <div className="bg-[#18120e] border-b border-[#3d2d20] px-4 py-2 text-xs flex items-center justify-between">
          <div className="flex items-center space-x-2 text-[#e2b871]">
            <Terminal className="w-4 h-4" />
            <span className="font-bold">Hidden Developer Tools Mode</span>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={() => setDevTab('review')}
              className={`px-3 py-1 rounded text-xs font-semibold ${
                devTab === 'review' ? 'bg-[#8c6543] text-white' : 'bg-[#261c17] text-[#a8988a]'
              }`}
            >
              Code Review
            </button>
            <button
              onClick={() => setDevTab('code')}
              className={`px-3 py-1 rounded text-xs font-semibold ${
                devTab === 'code' ? 'bg-[#8c6543] text-white' : 'bg-[#261c17] text-[#a8988a]'
              }`}
            >
              Codebase & Exporter
            </button>
            <button
              onClick={() => setDevTab('guide')}
              className={`px-3 py-1 rounded text-xs font-semibold ${
                devTab === 'guide' ? 'bg-[#8c6543] text-white' : 'bg-[#261c17] text-[#a8988a]'
              }`}
            >
              cPanel Guide
            </button>
            <button
              onClick={() => setShowDevTools(false)}
              className="px-2 py-1 bg-rose-900/60 text-rose-200 rounded text-xs"
            >
              Hide
            </button>
          </div>
        </div>
      )}

      {/* Main View Area */}
      <main className="flex-1 w-full min-h-screen flex flex-col">
        {!showDevTools ? (
          <iframe
            src="/campaign.html"
            title="Edgevest Bulk Email Campaign Web App"
            className="w-full h-screen min-h-screen border-0 flex-1"
          />
        ) : (
          <div className="max-w-7xl mx-auto px-4 py-6 w-full flex-1">
            {devTab === 'review' && <CodeReviewTab />}
            {devTab === 'code' && <CodeExplorerTab />}
            {devTab === 'guide' && <DeploymentGuideTab />}
          </div>
        )}
      </main>
    </div>
  );
}
