import type { MediaViewerItem } from "./media-viewer-item";

/**
 * Turns a support thread into the list the viewer pages through.
 *
 * ── Why the whole thread and not one message ──────────────────────────────
 * Attachments arrive one message at a time, but a person looking at the second
 * screenshot wants the third — which usually sits in a later reply. Collecting
 * across the thread is what makes paging worth having; collecting per message
 * would give most threads a "gallery" of exactly one.
 *
 * ── Why images only ───────────────────────────────────────────────────────
 * A video attachment keeps its download chip. Support attachments are
 * overwhelmingly screenshots, a clip can be large, and routing video into a
 * viewer with no save control would take away the only way to get the file out.
 * FAQ media is the opposite case — an operator publishes video there on
 * purpose — and it does go through the viewer.
 */

export interface ViewableAttachmentSource {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
}

export interface ViewableMessage {
  readonly attachments?: readonly ViewableAttachmentSource[] | null;
}

/** A viewer item that still knows which attachment it came from. */
export interface ViewableAttachment extends MediaViewerItem {
  readonly id: string;
}

/** Whether this attachment is one the viewer will show. */
export function isViewableAttachment(attachment: ViewableAttachmentSource): boolean {
  return typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("image/");
}

export function collectViewableAttachments(
  messages: readonly ViewableMessage[] | null | undefined,
  toUrl: (attachment: ViewableAttachmentSource) => string,
): readonly ViewableAttachment[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) =>
    (message.attachments ?? [])
      .filter(isViewableAttachment)
      .map((attachment: ViewableAttachmentSource) => ({
        id: attachment.id,
        url: toUrl(attachment),
        kind: "image" as const,
        label: attachment.filename,
      })),
  );
}

/**
 * Where this attachment sits in the collected list.
 *
 * `-1` for one that is not in it, which the caller treats as "no viewer for
 * this chip". Looking the index up by id rather than counting positions in the
 * rendered thread is deliberate: the two lists are filtered differently, and a
 * thread with one non-image attachment in the middle is all it takes for
 * position-counting to open the wrong picture.
 */
export function indexOfAttachment(
  items: readonly ViewableAttachment[],
  id: string,
): number {
  return items.findIndex((item) => item.id === id);
}
