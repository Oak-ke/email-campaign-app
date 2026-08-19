import crypto from "crypto";

export const SESSION_COOKIE_NAME = "ev_session";

export interface SmtpSessionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  use_tls: boolean;
  use_ssl: boolean;
  authenticatedAt: string;
}

// In-memory store mapping session tokens to verified SMTP credentials
const sessionSmtpStore = new Map<string, SmtpSessionConfig>();

export function setSessionSmtp(token: string, config: SmtpSessionConfig): void {
  if (token) {
    sessionSmtpStore.set(token, config);
  }
}

export function getSessionSmtp(token: string): SmtpSessionConfig | undefined {
  if (!token) return undefined;
  return sessionSmtpStore.get(token);
}

export function removeSessionSmtp(token: string): void {
  if (token) {
    sessionSmtpStore.delete(token);
  }
}

let hasWarnedMissingSecret = false;

/**
 * Secret key for signing cookies and tokens.
 * Warns if SESSION_SECRET is missing from environment.
 */
export function getSessionSecret(): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  if (!hasWarnedMissingSecret) {
    console.warn("⚠️ [SECURITY WARNING] SESSION_SECRET environment variable is missing. Using default secret. Please configure SESSION_SECRET in production.");
    hasWarnedMissingSecret = true;
  }
  return "edgevest_default_generated_session_secret_2026_x89a";
}

/**
 * Timing-safe string comparison to prevent timing side-channel attacks.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf-8");
    const bufB = Buffer.from(b, "utf-8");
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Generates a signed session token.
 */
export function generateSessionToken(username: string): string {
  const secret = getSessionSecret();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `${username}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

/**
 * Verifies a session token.
 */
export function verifySessionToken(token: string): { valid: boolean; username: string | null } {
  try {
    if (!token || typeof token !== "string") return { valid: false, username: null };

    // Strip Express cookie-parser "s:" prefix and signature suffix if present
    let rawToken = token.trim();
    if (rawToken.startsWith("s:")) {
      rawToken = rawToken.substring(2);
      const dotIndex = rawToken.lastIndexOf(".");
      if (dotIndex !== -1) {
        rawToken = rawToken.substring(0, dotIndex);
      }
    }

    const decoded = Buffer.from(rawToken, "base64url").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return { valid: false, username: null };

    const [username, expiresAtStr, signature] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      return { valid: false, username: null }; // Expired
    }

    const payload = `${username}:${expiresAtStr}`;
    const expectedSig = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("hex");

    if (crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedSig, "hex"))) {
      return { valid: true, username };
    }
  } catch (err) {
    console.error("[AUTH VERIFY ERROR]", err);
  }
  return { valid: false, username: null };
}

/**
 * Prevents open-redirect vulnerabilities by validating that redirect paths start with '/'.
 */
export function sanitizeRedirectUrl(nextUrl?: string): string {
  if (!nextUrl || typeof nextUrl !== "string") {
    return "/campaign.html";
  }
  const clean = nextUrl.trim();
  if (clean.startsWith("/") && !clean.startsWith("//") && !clean.includes(":\\") && !clean.includes(":/")) {
    return clean;
  }
  return "/campaign.html";
}
