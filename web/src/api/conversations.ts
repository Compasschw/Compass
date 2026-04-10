import { api } from "./client";

export interface MessageData {
  id: string; conversation_id: string; sender_id: string;
  body: string; type: string; created_at: string;
}

export const fetchConversations = () =>
  api<Array<{ id: string; chw_id: string; member_id: string; session_id: string | null; created_at: string }>>("/conversations/");
export const fetchMessages = (id: string) => api<MessageData[]>("/conversations/" + id + "/messages");
export const sendMessage = (id: string, body: string, type = "text") =>
  api<MessageData>("/conversations/" + id + "/messages", { method: "POST", body: JSON.stringify({ body, type }) });
