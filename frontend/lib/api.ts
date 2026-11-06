export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
export function apiFetch(input: string, init: RequestInit = {}) {
  return fetch(input.startsWith("http") ? input : `${API}${input}`, { ...init, credentials: "include", cache: "no-store" });
}
