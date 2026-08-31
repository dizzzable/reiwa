/**
 * One thing the viewer can show.
 *
 * Its own module so the tested logic beside it depends on nothing but this —
 * the component that renders these lives in each app and differs; the rules for
 * paging, zooming and collecting them do not, and are vendored between repos.
 */
export interface MediaViewerItem {
  readonly url: string;
  readonly kind: "image" | "video";
  readonly label: string;
}
