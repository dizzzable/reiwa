/**
 * SetLoginPasswordForm
 * ────────────────────
 * A login and a password for a customer who has neither: one who came in
 * through the bot or the Mini App and never needed them. Optional — nothing in
 * the app sends a customer here; they reach it from «Привязать Email» (offered
 * once the address is confirmed) or from the permanent «Логин и пароль» entry
 * in «Конфиденциальность».
 *
 * Which endpoint it calls follows the session, so it works against any panel:
 *  - no web account yet: `/auth/claim`, the mandatory `/claim` page's endpoint,
 *    which makes the account - and, on a panel that makes the shell
 *    linking an e-mail leaves, fills that shell too, which is what a session
 *    fetched a moment before the address was confirmed still shows as no account;
 *  - a shell without a login: `/auth/ext/finish-setup`, which every panel has
 *    always accepted for exactly that account.
 */

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SESSION_QUERY_KEY, useSession } from "@/hooks/use-session";
import { claimAccount, finishExternalSetup } from "@/lib/api-client";
import { hashPassword } from "@/lib/crypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SavedCredentials } from "@/features/auth/save-credentials";
import { validateLoginName, validateNewPassword } from "@/features/auth/credential-rules";

export function SetLoginPasswordForm({
  hint,
  onSaved,
  onLater,
}: {
  /** The line above the fields; `null` where the caller has already said it. */
  readonly hint?: string | null;
  /** The login and password just chosen, for «Сохраните данные для входа». */
  readonly onSaved: (credentials: SavedCredentials) => void;
  /** «Не сейчас» — shown only where the form is an offer rather than an entry. */
  readonly onLater?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const nextUsernameError = validateLoginName(username);
    const nextPasswordError = validateNewPassword(password);
    setUsernameError(nextUsernameError);
    setPasswordError(nextPasswordError);
    if (nextUsernameError !== null || nextPasswordError !== null || submitting) return;

    setSubmitting(true);
    setServerError(null);
    try {
      const passwordHash = await hashPassword(password);
      if (session?.webAccount != null) {
        await finishExternalSetup({ username, passwordHash });
      } else {
        await claimAccount(username, passwordHash);
      }
      // The session now carries the login: the privacy page stops offering this.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      onSaved({ login: username, password });
    } catch (err: unknown) {
      setSubmitting(false);
      setServerError(describeFailure(err, t));
    }
  }

  return (
    <form className="space-y-4 py-4" onSubmit={(event) => void handleSubmit(event)} noValidate>
      {hint !== null && (
        <p className="text-sm text-muted-foreground">{hint ?? t("privacy.loginPasswordHint")}</p>
      )}
      <div className="space-y-2">
        <Label htmlFor="set-login-username">{t("claim.usernameLabel")}</Label>
        <Input
          id="set-login-username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          disabled={submitting}
          placeholder={t("claim.usernamePlaceholder")}
          aria-invalid={usernameError !== null}
          onChange={(event) => {
            const value = event.target.value;
            setUsername(value);
            setServerError(null);
            setUsernameError(value ? validateLoginName(value) : null);
          }}
        />
        <div className="min-h-4 text-xs text-red-400" aria-live="polite">
          {usernameError !== null && t(`claim.usernameError.${usernameError}`)}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="set-login-password">{t("claim.passwordLabel")}</Label>
        <Input
          id="set-login-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={submitting}
          placeholder={t("claim.passwordPlaceholder")}
          aria-invalid={passwordError !== null}
          onChange={(event) => {
            const value = event.target.value;
            setPassword(value);
            setServerError(null);
            setPasswordError(value ? validateNewPassword(value) : null);
          }}
        />
        <div className="min-h-4 text-xs text-red-400" aria-live="polite">
          {passwordError !== null && t(`claim.passwordError.${passwordError}`)}
        </div>
      </div>
      {serverError !== null && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
          {serverError}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          className="w-full"
          style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
          disabled={submitting || username.length === 0 || password.length === 0}
        >
          {submitting ? t("common.loading") : t("privacy.setLoginSubmit")}
        </Button>
        {onLater !== undefined && (
          <Button type="button" variant="ghost" className="w-full" disabled={submitting} onClick={onLater}>
            {t("privacy.setLoginLater")}
          </Button>
        )}
      </div>
    </form>
  );
}

/** What the customer is told for each way the panel can refuse a first login. */
function describeFailure(err: unknown, t: (key: string, options?: Record<string, unknown>) => string): string {
  const response = (err as {
    response?: { status?: number; data?: { retryAfter?: number } };
  } | null)?.response;
  switch (response?.status) {
    case 409:
      return t("claim.errorUsernameTaken");
    case 400:
      return t("privacy.setLoginRejected");
    case 429: {
      const retryAfter = response.data?.retryAfter;
      return t("claim.errorRateLimit", {
        seconds: typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 60,
      });
    }
    case 502:
    case 503:
      return t("claim.errorServiceUnavailable");
    default:
      return t("claim.errorGeneric");
  }
}
