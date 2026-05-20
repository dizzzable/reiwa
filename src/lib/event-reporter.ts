/**
 * EventReporter
 * ─────────────
 * Sends system events from reiwa to rezeis-admin via the internal API.
 * Events are delivered fire-and-forget — failures are logged but never
 * block the caller.
 *
 * Used for:
 *   - Brute-force detection alerts (IP banned)
 *   - Rate-limit violations
 *   - Admin client connection failures
 *   - Bot webhook errors
 *   - Worker failures
 *   - Session anomalies
 */

import type { AdminClient } from "./admin-client.js";

export type EventSeverity = "INFO" | "WARNING" | "ERROR";
export type EventCategory = "USER" | "AUTH" | "SYSTEM" | "SUBSCRIPTION" | "PAYMENT";

export interface ReiwaEvent {
  type: string;
  category: EventCategory;
  severity: EventSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}

// Predefined reiwa event types
export const REIWA_EVENTS = {
  // Auth/Security
  BRUTE_FORCE_DETECTED: "reiwa.brute_force_detected",
  RATE_LIMIT_TRIGGERED: "reiwa.rate_limit_triggered",
  IP_BANNED: "reiwa.ip_banned",
  SESSION_ANOMALY: "reiwa.session_anomaly",
  LOGIN_FAILED_REPEATED: "reiwa.login_failed_repeated",

  // Connection
  ADMIN_CLIENT_UNREACHABLE: "reiwa.admin_client_unreachable",
  ADMIN_CLIENT_TIMEOUT: "reiwa.admin_client_timeout",
  REDIS_CONNECTION_LOST: "reiwa.redis_connection_lost",

  // Bot
  BOT_WEBHOOK_ERROR: "reiwa.bot_webhook_error",
  BOT_COMMAND_ERROR: "reiwa.bot_command_error",

  // Worker
  WORKER_EXPIRY_ALERT_FAILED: "reiwa.worker_expiry_alert_failed",

  // User actions
  USER_REGISTERED_WEB: "reiwa.user_registered_web",
  USER_REGISTERED_TMA: "reiwa.user_registered_tma",
  USER_PASSWORD_CHANGED: "reiwa.user_password_changed",
  USER_TELEGRAM_LINKED: "reiwa.user_telegram_linked",
} as const;

export class EventReporter {
  private adminClient: AdminClient | null;

  constructor(adminClient: AdminClient | null) {
    this.adminClient = adminClient;
  }

  /**
   * Send an event to rezeis-admin. Fire-and-forget.
   */
  emit(event: ReiwaEvent): void {
    if (!this.adminClient) return;

    this.adminClient
      .request("POST", "/api/internal/events", {
        type: event.type,
        category: event.category,
        severity: event.severity,
        message: event.message,
        metadata: {
          source: "reiwa",
          ...(event.metadata ?? {}),
        },
      })
      .catch((err) => {
        // Silent fail — we don't want event reporting to break the app
        console.error(`[EventReporter] Failed to send event ${event.type}: ${(err as Error).message}`);
      });
  }

  /** Convenience: emit INFO event */
  info(type: string, category: EventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: "INFO", message, metadata });
  }

  /** Convenience: emit WARNING event */
  warn(type: string, category: EventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: "WARNING", message, metadata });
  }

  /** Convenience: emit ERROR event */
  error(type: string, category: EventCategory, message: string, metadata?: Record<string, unknown>): void {
    this.emit({ type, category, severity: "ERROR", message, metadata });
  }
}
