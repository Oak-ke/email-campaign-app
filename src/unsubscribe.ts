import crypto from "crypto";

const DEFAULT_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.CAMPAIGN_API_TOKEN || "edgevest_unsub_secret_2026";

/**
 * Creates a signed HMAC-SHA256 unsubscribe token encoding the email and timestamp.
 */
export function createUnsubscribeToken(email: string, secret: string = DEFAULT_SECRET, expiresInDays: number = 30): string {
  const cleanEmail = email.trim().toLowerCase();
  const expiresAt = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;
  const payload = `${cleanEmail}:${expiresAt}`;
  const hmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const tokenData = `${payload}:${hmac}`;
  return Buffer.from(tokenData).toString("base64url");
}

/**
 * Verifies a signed unsubscribe token and returns the clean email if valid, or null if invalid/expired.
 */
export function verifyUnsubscribeToken(token: string, secret: string = DEFAULT_SECRET): string | null {
  try {
    if (!token) return null;
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return null;

    const [email, expiresAtStr, hmac] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return null; // Expired
    }

    const payload = `${email}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    if (crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expectedHmac, "hex"))) {
      return email.toLowerCase();
    }
  } catch (err) {
    console.error("[UNSUB VERIFY ERROR]", err);
  }
  return null;
}

/**
 * Builds the full unsubscribe URL for a recipient.
 */
export function buildUnsubscribeUrl(baseUrl: string, email: string, secret: string = DEFAULT_SECRET): string {
  const token = createUnsubscribeToken(email, secret);
  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}/unsubscribe?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
}

/**
 * Injects an unsubscribe link footer into an HTML email body if not already present.
 */
export function injectUnsubscribeFooter(htmlBody: string, unsubUrl: string): string {
  if (htmlBody.includes("unsubscribe") || htmlBody.includes(unsubUrl)) {
    return htmlBody;
  }

  const footerHtml = `
<div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #e2e8f0; font-family: sans-serif; font-size: 11px; color: #718096; text-align: center;">
  <p style="margin: 0 0 6px 0;">You received this email from Edgevest Campaign Manager.</p>
  <p style="margin: 0;">If you prefer not to receive future marketing emails, you can <a href="${unsubUrl}" style="color: #4a5568; text-decoration: underline;">unsubscribe here</a>.</p>
</div>`;

  if (htmlBody.includes("</body>")) {
    return htmlBody.replace("</body>", `${footerHtml}</body>`);
  }
  return htmlBody + footerHtml;
}
