import { LogOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StadiumButton } from "@/components/ui/stadium-button";

/**
 * The one confirmation shown before signing out.
 *
 * Shared rather than copied because the confirmation is the part with a
 * decision in it. Two dialogs would be two chances for one of them to lose the
 * cancel button, stop showing the pending state, or drift to different wording
 * — and this is the control that ends a session, so the surface a person sees
 * should not depend on which door they reached it through.
 *
 * The copy stays on the existing `settings.*` keys deliberately. They are what
 * every operator has already translated and, where the panel's text editor is
 * used, already rewritten; minting `sidebar.*` twins would silently revert
 * those overrides for the desktop door only.
 */
export function SignOutConfirmDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly isPending: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{t("settings.signOut")}</DialogTitle>
          <DialogDescription>{t("settings.signOutConfirm")}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex flex-col gap-2">
          <StadiumButton
            variant="danger"
            size="lg"
            fullWidth
            loading={props.isPending}
            icon={<LogOut className="h-5 w-5" />}
            onClick={props.onConfirm}
          >
            {t("settings.signOut")}
          </StadiumButton>
          <StadiumButton variant="ghost" size="md" fullWidth onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </StadiumButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
