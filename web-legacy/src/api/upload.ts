import { api } from "./client";

export async function getPresignedUploadUrl(filename: string, contentType: string, purpose = "credential") {
  return api<{ upload_url: string; s3_key: string }>("/upload/presigned-url", {
    method: "POST", body: JSON.stringify({ filename, content_type: contentType, purpose }),
  });
}

export async function uploadFile(file: File, purpose = "credential"): Promise<string> {
  const { upload_url, s3_key } = await getPresignedUploadUrl(file.name, file.type, purpose);
  await fetch(upload_url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  return s3_key;
}
