/** Decodes base64url (as in JWTs and VAPID keys) to a binary string, like `atob`. */
export function base64UrlDecode(value: string): string {
  return atob(value.replace(/-/g, '+').replace(/_/g, '/'));
}

/** Decodes base64url to bytes, as `PushManager.subscribe()` takes a VAPID key. */
export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(base64UrlDecode(value), (character) => character.charCodeAt(0));
}
