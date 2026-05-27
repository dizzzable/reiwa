/**
 * Redis module — key schema, TTL constants, and session middleware.
 */

export {
  TTL,
  sessionKey,
  telegramLinkKey,
  emailVerifyKey,
  recoveryKey,
  rateLoginKey,
  rateRegisterKey,
  rateRecoverKey,
  installDismissedKey,
  installPermanentDismissKey,
  ipBlockKey,
  bruteForceKey,
  bannedIpKey,
  recoveryQueueKey,
} from "./keys.js";

export {
  WebSessionStore,
  createWebSessionMiddleware,
  type WebSession,
  type SessionConfig,
} from "./session.js";

// Type augmentation side-effect import
import "./types.js";
