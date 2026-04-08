import { api } from "./client";

export interface CredentialValidation {
  id: string; chw_id: string; program_name: string;
  validation_status: string; institution_confirmed: boolean; created_at: string;
}

export const submitCredentialValidation = (data: Record<string, unknown>) =>
  api<CredentialValidation>("/credentials/validate", { method: "POST", body: JSON.stringify(data) });
export const fetchValidations = () => api<CredentialValidation[]>("/credentials/validations");
export const reviewValidation = (id: string, approved: boolean, notes = "") =>
  api("/credentials/validations/" + id + "/review?approved=" + approved + "&notes=" + encodeURIComponent(notes), { method: "PATCH" });
export const searchInstitutions = (q: string) => api("/credentials/institutions?q=" + encodeURIComponent(q));
