/**
 * Custom emoji packs — operator-uploaded emoji rendered inline in the cabinet
 * feed. Served by reiwa-api (`/api/v1/custom-emoji/packs`), which proxies the
 * admin host. Assets load same-origin via the `/uploads/emoji/*` proxy.
 */
import { apiClient } from "./transport.js";
import { configVersionRequest } from "@/lib/config-versions";

export interface CustomEmojiItem {
  slug: string;
  name: string;
  imageUrl: string;
  lottieUrl: string | null;
  fallback: string | null;
}
export interface CustomEmojiPack {
  id: string;
  name: string;
  emojis: CustomEmojiItem[];
}

/** With the version the cabinet holds once it is known (`?v=`, `lib/config-versions.ts`). */
export const getCustomEmojiPacks = () => {
  const versioned = configVersionRequest("customEmojiPacks");
  return (
    versioned === undefined
      ? apiClient.get<CustomEmojiPack[]>("/custom-emoji/packs")
      : apiClient.get<CustomEmojiPack[]>("/custom-emoji/packs", versioned)
  ).then((r) => r.data);
};
