/**
 * AI Chat namespace — conversation with AI assistant.
 */
import { apiClient } from "./transport.js";

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatResponse {
  response: string;
  conversationId: string;
}

export const sendAiMessage = (message: string, conversationId?: string): Promise<AiChatResponse> =>
  apiClient.post("/ai-chat/message", { message, conversationId });
