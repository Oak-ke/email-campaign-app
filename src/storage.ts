import fs from "fs";
import path from "path";

export interface SuppressionRecord {
  email: string;
  reason: string;
  source: string;
  created_at: string;
}

export interface UnsubscribeEvent {
  id: string;
  email: string;
  ip: string;
  user_agent: string;
  created_at: string;
}

interface StorageData {
  suppressions: Record<string, SuppressionRecord>;
  unsubscribe_events: UnsubscribeEvent[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const STORAGE_FILE = path.join(DATA_DIR, "suppressions.json");

// Ensure data directory exists on module load
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error("[STORAGE] Failed to create data directory:", err);
  }
}

function loadStorage(): StorageData {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const raw = fs.readFileSync(STORAGE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        suppressions: parsed.suppressions || {},
        unsubscribe_events: parsed.unsubscribe_events || []
      };
    }
  } catch (err) {
    console.error("[STORAGE] Error reading storage file, initializing fresh:", err);
  }
  return { suppressions: {}, unsubscribe_events: [] };
}

function saveStorage(data: StorageData): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[STORAGE] Error saving storage file:", err);
  }
}

export const suppressionStore = {
  isSuppressed(email: string): boolean {
    if (!email) return false;
    const cleanEmail = email.trim().toLowerCase();
    const data = loadStorage();
    return !!data.suppressions[cleanEmail];
  },

  addSuppression(email: string, reason: string = "user_unsubscribe", source: string = "unsubscribe_link"): SuppressionRecord {
    const cleanEmail = email.trim().toLowerCase();
    const data = loadStorage();
    const record: SuppressionRecord = {
      email: cleanEmail,
      reason,
      source,
      created_at: new Date().toISOString()
    };
    data.suppressions[cleanEmail] = record;
    saveStorage(data);
    return record;
  },

  removeSuppression(email: string): boolean {
    const cleanEmail = email.trim().toLowerCase();
    const data = loadStorage();
    if (data.suppressions[cleanEmail]) {
      delete data.suppressions[cleanEmail];
      saveStorage(data);
      return true;
    }
    return false;
  },

  listSuppressions(): SuppressionRecord[] {
    const data = loadStorage();
    return Object.values(data.suppressions);
  },

  logUnsubscribeEvent(email: string, ip: string = "unknown", userAgent: string = "unknown"): void {
    const data = loadStorage();
    const event: UnsubscribeEvent = {
      id: "unsub_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8),
      email: email.trim().toLowerCase(),
      ip,
      user_agent: userAgent,
      created_at: new Date().toISOString()
    };
    data.unsubscribe_events.push(event);
    saveStorage(data);
  },

  getUnsubscribeEvents(): UnsubscribeEvent[] {
    const data = loadStorage();
    return data.unsubscribe_events;
  }
};
