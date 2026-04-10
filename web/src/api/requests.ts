import { api } from "./client";

export interface ServiceRequestData {
  id: string; member_id: string; matched_chw_id: string | null;
  vertical: string; urgency: string; description: string;
  preferred_mode: string; status: string; estimated_units: number;
  created_at: string; member_name: string | null;
}

export const fetchRequests = (): Promise<ServiceRequestData[]> => api("/requests/");
export const createRequest = (data: Record<string, unknown>) =>
  api<ServiceRequestData>("/requests/", { method: "POST", body: JSON.stringify(data) });
export const acceptRequest = (id: string) => api("/requests/" + id + "/accept", { method: "PATCH" });
export const passRequest = (id: string) => api("/requests/" + id + "/pass", { method: "PATCH" });
