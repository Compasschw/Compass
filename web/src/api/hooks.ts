import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchSessions, startSession, completeSession } from "./sessions";
import { fetchRequests, acceptRequest, passRequest } from "./requests";
import { fetchConversations, fetchMessages, sendMessage } from "./conversations";
import { fetchValidations } from "./credentials";

// Sessions
export function useSessions() {
  return useQuery({ queryKey: ["sessions"], queryFn: fetchSessions });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: startSession, onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }) });
}

export function useCompleteSession() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: completeSession, onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }) });
}

// Requests
export function useRequests() {
  return useQuery({ queryKey: ["requests"], queryFn: fetchRequests });
}

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: acceptRequest, onSuccess: () => qc.invalidateQueries({ queryKey: ["requests"] }) });
}

export function usePassRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: passRequest, onSuccess: () => qc.invalidateQueries({ queryKey: ["requests"] }) });
}

// Conversations
export function useConversations() {
  return useQuery({ queryKey: ["conversations"], queryFn: fetchConversations });
}

export function useMessages(conversationId: string) {
  return useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => fetchMessages(conversationId),
    enabled: !!conversationId,
  });
}

export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => sendMessage(conversationId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages", conversationId] }),
  });
}

// Credentials
export function useCredentialValidations() {
  return useQuery({ queryKey: ["credential-validations"], queryFn: fetchValidations });
}
