/**
 * Custom emoji packs — operator-uploaded emoji rendered inline in the cabinet
 * feed. Served by reiwa-api (`/api/v1/custom-emoji/packs`), which proxies the
 * admin host. Assets load same-origin via the `/uploads/emoji/*` proxy.
 */
import { apiClient } from "./transport.js";

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

export const getCustomEmojiPacks = () =>
  apiClient.get<CustomEmojiPack[]>("/custom-emoji/packs").then((r) => r.data);
