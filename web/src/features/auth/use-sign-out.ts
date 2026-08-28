import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { signOut } from "@/lib/api-client";

/**
 * What "log out" means, in one place.
 *
 * Two surfaces offer it now — the Settings screen on mobile and the sidebar on
 * desktop — and the reason this is a hook rather than two copies of a
 * `useMutation` call is the error branch. Signing out has to end at the same
 * place whether the request succeeded or not: the server session is a cookie,
 * so a failed `POST /auth/logout` still leaves a browser holding cached
 * answers for a person who asked to leave. Clearing the cache and navigating
 * only on success would strand exactly the user whose network just failed —
 * still signed in, staring at a button that did nothing.
 *
 * There is deliberately nothing else in here. Auth is a server session cookie
 * (`reiwa_web_session`), no client token exists to clear, and the endpoint is
 * idempotent by design — it clears both cookies and answers `{ success: true }`
 * even when the session store errors.
 */
export function useSignOut(): { readonly signOut: () => void; readonly isPending: boolean } {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: signOut,
    onSettled: () => {
      queryClient.clear();
      navigate("/bootstrap", { replace: true });
    },
  });

  return { signOut: () => mutation.mutate(), isPending: mutation.isPending };
}
