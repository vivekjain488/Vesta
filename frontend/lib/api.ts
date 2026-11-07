// Production uses a same-origin rewrite so the backend's HttpOnly, SameSite=Strict session cookie works.
export const API = process.env.NODE_ENV === "production" ? "/backend" : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787");
export function apiFetch(input: string, init: RequestInit = {}) {
  return fetch(input.startsWith("http") ? input : `${API}${input}`, { ...init, credentials: "include", cache: "no-store" });
}
