import crypto from "crypto";
import express from "express";

export const SESSION_COOKIE_NAME = "ev_session";

// Secret key for signing cookies and tokens
export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.APP_PASSWORD || process.env.ADMIN_PASSWORD || "edgevest_session_secret_default_2026";
}

// Configured admin credentials
export function getAdminCredentials() {
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = (process.env.APP_PASSWORD || process.env.ADMIN_PASSWORD || "edgevest2026").trim();
  return { username, password };
}

/**
 * Timing-safe string comparison to prevent timing side-channel attacks on password verification.
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
 * Prevents open-redirect vulnerabilities by validating that redirect paths start with '/' and do not contain protocol/host specifiers.
 */
export function sanitizeRedirectUrl(nextUrl?: string): string {
  if (!nextUrl || typeof nextUrl !== "string") {
    return "/campaign.html";
  }
  const clean = nextUrl.trim();
  // Ensure it starts with a single '/' and not '//' or 'http:'
  if (clean.startsWith("/") && !clean.startsWith("//") && !clean.includes(":\\") && !clean.includes(":/")) {
    return clean;
  }
  return "/campaign.html";
}
