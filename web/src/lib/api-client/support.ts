/**
 * Support tickets namespace.
 */
import { apiClient } from "./transport.js";

export interface SupportTicket {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: SupportTicketMessage[];
}

export interface SupportTicketMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  content: string;
  createdAt: string;
}

export const getTickets = () =>
  apiClient.get<SupportTicket[]>("/support/tickets").then((r) => r.data);

export const getTicket = (ticketId: string) =>
  apiClient
    .get<SupportTicket>(`/support/tickets/${ticketId}`)
    .then((r) => r.data);

export const createTicket = (subject: string, message: string) =>
  apiClient
    .post<SupportTicket>("/support/tickets", { subject, message })
    .then((r) => r.data);

export const replyToTicket = (ticketId: string, content: string) =>
  apiClient
    .post<SupportTicketMessage>(`/support/tickets/${ticketId}/reply`, { content })
    .then((r) => r.data);
