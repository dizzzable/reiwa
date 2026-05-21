/**
 * Context Detection Middleware
 *
 * Determines whether the incoming request originates from a Telegram Mini App (TMA)
 * or a regular web browser, based on the presence and validity of Telegram WebApp initData.
 *
 * Behavior:
 * - If `x-telegram-init-data` header is present and valid → req.context = "tma"
 * - If `x-telegram-init-data` header is present but corrupted → 403 Forbidden (block access)
 * - If `x-telegram-init-data` header is absent or detection fails → req.context = "web"
 *
 * Requirements: 10.4, 10.5, 10.6
 */

import type { Request, Response, NextFunction } from "express";
import { validateTelegramInitData } from "../../lib/telegram-auth.js";

export type RequestContext = "tma" | "web";

export interface ContextDetectionOptions {
  /** Telegram Bot token used to validate initData HMAC signature */
  botToken: string | undefined;
}

/**
 * Creates the context detection middleware.
 *
 * @param options - Configuration including the bot token for initData validation
 */
export function createContextDetectionMiddleware(options: ContextDetectionOptions) {
  const { botToken } = options;

  return function contextDetection(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const initDataHeader = req.headers["x-telegram-init-data"];

    // No initData header present → web context
    if (!initDataHeader) {
      req.context = "web";
      next();
      return;
    }

    // Normalize header value (could be string or string[])
    const initData = Array.isArray(initDataHeader)
      ? initDataHeader[0]
      : initDataHeader;

    // Empty or whitespace-only header → treat as absent, default to web
    if (!initData || !initData.trim()) {
      req.context = "web";
      next();
      return;
    }

    // If no bot token is configured, we cannot validate initData.
    // This is a detection failure (indeterminate state) → default to web context.
    if (!botToken) {
      req.context = "web";
      next();
      return;
    }

    // Attempt to validate the initData
    try {
      const validUser = validateTelegramInitData(initData, botToken);

      if (validUser) {
        // Valid initData → TMA context
        req.context = "tma";
        next();
        return;
      }

      // initData is present but validation failed → corrupted, block access entirely
      res.status(403).json({
        message: "Forbidden: invalid Telegram initData",
      });
      return;
    } catch {
      // Detection itself failed (unexpected error) → default to web context
      // and allow fallback to web sign-in
      req.context = "web";
      next();
      return;
    }
  };
}
