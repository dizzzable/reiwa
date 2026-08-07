/**
 * Reader for one legal document.
 *
 * The body is rendered as TEXT — `whitespace-pre-wrap` inside a scroll area,
 * no markdown, no `dangerouslySetInnerHTML`. This component is reachable from
 * the registration screen, which is the pre-login bundle; that bundle keeps
 * DOMPurify out on purpose, so there is nothing here that could safely
 * interpret markup even if the operator pasted some in.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LegalDocument } from "@/lib/api-client";

export function LegalDocumentDialog({
  document,
  onClose,
}: {
  readonly document: LegalDocument | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={document !== null} onOpenChange={(open) => !open && onClose()}>
      {/* `sm:max-w-2xl`, not `max-w-2xl`: the base DialogContent sets
          `sm:max-w-sm`, and tailwind-merge does not treat an unprefixed class
          as conflicting with a prefixed one — both survive and the media query
          wins, leaving a legal text to be read in a narrow column. */}
      <DialogContent className="max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{document?.title ?? ""}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto pr-1">
          <p className="text-muted-foreground text-sm leading-relaxed whitespace-pre-wrap">
            {document?.body ?? ""}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
