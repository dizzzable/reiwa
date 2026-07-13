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

export interface AiChatConfig {
  enabled: boolean;
}

// NOTE: must unwrap `.data` — returning the AxiosResponse directly type-checks
// (contextual generic) but yields `undefined` for response/conversationId.
export const sendAiMessage = (message: string, conversationId?: string): Promise<AiChatResponse> =>
  apiClient
    .post<AiChatResponse>("/ai-chat/message", { message, conversationId })
    .then((r) => r.data);

/** Whether the operator has the assistant enabled (drives tab visibility). */
export const getAiChatConfig = (): Promise<AiChatConfig> =>
  apiClient.get<AiChatConfig>("/ai-chat/config").then((r) => r.data);
