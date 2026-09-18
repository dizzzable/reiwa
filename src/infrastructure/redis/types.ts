/**
 * Express Request type augmentation for web session and context detection support.
 */

import type { WebSession } from "./session.js";
import type { RequestContext } from "../../api/middleware/context-detection.js";

declare global {
  namespace Express {
    interface Request {
      /** Current web session data (null if not authenticated) */
      webSession: WebSession | null;
      /** Current web session ID (null if not authenticated) */
      webSessionId: string | null;
      /**
       * Create a new web session and set the cookie. `authFloor`: the panel's
       * `sessionsRevokedAt` when this session is opened by the change that
       * signed every other session out, so that change does not sign it out.
       */
      createWebSession: (userId: string, options?: { readonly authFloor?: number }) => Promise<string>;
      /**
       * Replace the current session with a fresh one (new id, same customer,
       * installed-app flag kept) that counts from `authFloor`, and destroy the
       * old one. For the browser that just signed every other session out.
       * `null` when there is no current session.
       */
      renewWebSession: (options: { readonly authFloor: number }) => Promise<string | null>;
      /** Mark the current session as an installed-PWA (standalone) session:
       *  flips the flag, extends the Redis TTL to 30 days, and re-issues the
       *  cookie with the 30-day maxAge. No-op when there's no active session. */
      markSessionStandalone: (platform: string) => Promise<void>;
      /** Destroy the current web session and clear the cookie */
      destroyWebSession: () => Promise<void>;
      /** Request context: "tma" if Telegram Mini App, "web" if browser */
      context: RequestContext;
    }
  }
}
