import React, { useState } from 'react';

function App() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | null; message: string }>({
    type: null,
    message: '',
  });

  const [form, setForm] = useState({
    smtpHost: '',
    smtpPort: 587,
    smtpUsername: '',
    smtpPassword: '',
    recipients: '',
    subject: '',
    body: '',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus({ type: null, message: '' });

    // Parse recipients (comma or newline separated)
    const recipientsList = form.recipients
      .split(/[\n,]/)
      .map(email => email.trim())
      .filter(Boolean);

    if (recipientsList.length === 0) {
      setStatus({ type: 'error', message: 'Please add at least one recipient email.' });
      setLoading(false);
      return;
    }

    const payload = {
      recipients: recipientsList,
      template: {
        subject: form.subject,
        body: form.body,
      },
      smtp: {
        host: form.smtpHost,
        port: Number(form.smtpPort),
        username: form.smtpUsername,
        password: form.smtpPassword,
      },
      settings: {
        delay: 0, // Send immediately
        batchSize: 10,
      },
    };

    try {
      const res = await fetch('/api/campaign/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus({ type: 'success', message: `✅ Campaign started! ${data.message || 'Emails are being sent.'}` });
        // Clear form on success? Optional.
      } else {
        setStatus({ type: 'error', message: `❌ Error: ${data.error || data.message || 'Unknown server error'}` });
      }
    } catch (err: any) {
      setStatus({ type: 'error', message: `❌ Network Error: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '700px', margin: '40px auto', padding: '0 20px', fontFamily: 'sans-serif' }}>
      <h1 style={{ borderBottom: '2px solid #eee', paddingBottom: '10px' }}>📧 Email Campaign Engine</h1>
      
      <form onSubmit={handleSubmit}>
        <h3>SMTP Configuration</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <input name="smtpHost" placeholder="SMTP Host (e.g., smtp.gmail.com)" value={form.smtpHost} onChange={handleChange} required style={inputStyle} />
          <input name="smtpPort" type="number" placeholder="Port (e.g., 587)" value={form.smtpPort} onChange={handleChange} required style={inputStyle} />
          <input name="smtpUsername" placeholder="Username / Email" value={form.smtpUsername} onChange={handleChange} required style={inputStyle} />
          <input name="smtpPassword" type="password" placeholder="Password / App Password" value={form.smtpPassword} onChange={handleChange} required style={inputStyle} />
        </div>

        <h3>Campaign Details</h3>
        <textarea name="recipients" placeholder="Recipient Emails (comma or newline separated)&#10;e.g., john@doe.com, jane@smith.com" value={form.recipients} onChange={handleChange} required style={{ ...inputStyle, minHeight: '60px' }} />
        
        <input name="subject" placeholder="Email Subject" value={form.subject} onChange={handleChange} required style={inputStyle} />
        
        <textarea name="body" placeholder="Email Body (HTML or Plain Text)" value={form.body} onChange={handleChange} required style={{ ...inputStyle, minHeight: '150px' }} />

        <button type="submit" disabled={loading} style={{
          padding: '12px 24px',
          background: loading ? '#aaa' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          fontSize: '16px',
          fontWeight: 'bold',
          cursor: loading ? 'default' : 'pointer',
          marginTop: '10px',
          width: '100%',
        }}>
          {loading ? '⏳ Starting Campaign...' : '🚀 Start Campaign'}
        </button>
      </form>

      {status.message && (
        <div style={{
          marginTop: '20px',
          padding: '12px',
          borderRadius: '6px',
          background: status.type === 'success' ? '#d4edda' : '#f8d7da',
          color: status.type === 'success' ? '#155724' : '#721c24',
          border: `1px solid ${status.type === 'success' ? '#c3e6cb' : '#f5c6cb'}`,
        }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

// Reusable input style
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  marginBottom: '12px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  fontSize: '14px',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

export default App;