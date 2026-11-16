/** The length of `text` in UTF-8 bytes, without encoding it. */
export function utf8Length(text: string): number {
  let bytes = text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) continue;
    // 2 bytes below U+0800; 3 above; a surrogate pair's 4 split over its two halves.
    bytes += code < 0x800 || (code >= 0xd800 && code <= 0xdfff) ? 1 : 2;
  }
  return bytes;
}
