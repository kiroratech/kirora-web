/** Decodes base64url (as in JWTs and VAPID keys) to a binary string, like `atob`. */
export function base64UrlDecode(value: string): string {
  return atob(value.replace(/-/g, '+').replace(/_/g, '/'));
}
