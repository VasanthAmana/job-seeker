/**
 * Decode a saved web page by the charset it declares, the way a browser
 * does. Port of tools/page_decode.py.
 *
 * Valid UTF-8 always wins. Only bytes that are not valid UTF-8 fall back to
 * what the page declares: a UTF-16 byte order mark, then `<meta charset>` or
 * the http-equiv Content-Type in the first 1024 bytes. Only the labels below
 * are honoured, so a page cannot select a codec such as UTF-7.
 */

const PRESCAN_BYTES = 1024;
const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]+)/i;

// Python codec name -> the WHATWG encoding label TextDecoder knows it by,
// and the labels a page may use for it.
const CODECS: Array<[string, string[]]> = [
  ["euc-kr", ["euc-kr", "cp949", "windows-949", "ks_c_5601-1987", "ks_c_5601-1989", "ksc5601", "ksc_5601", "korean", "iso-ir-149", "csksc56011987"]],
  ["shift_jis", ["shift_jis", "shift-jis", "sjis", "x-sjis", "ms_kanji", "ms932", "windows-31j", "csshiftjis"]],
  ["euc-jp", ["euc-jp", "x-euc-jp", "cseucpkdfmtjapanese"]],
  ["iso-2022-jp", ["iso-2022-jp", "csiso2022jp"]],
  ["gb18030", ["gb18030", "gbk", "gb2312", "x-gbk", "chinese", "csgb2312", "iso-ir-58"]],
  ["big5", ["big5", "big5-hkscs", "x-x-big5", "cn-big5", "csbig5"]],
  ["windows-1252", ["windows-1252", "cp1252", "x-cp1252", "iso-8859-1", "iso8859-1", "iso_8859-1", "latin1", "l1", "ascii", "us-ascii", "cp819", "ibm819"]],
  ["windows-1250", ["windows-1250", "cp1250", "x-cp1250"]],
  ["windows-1251", ["windows-1251", "cp1251", "x-cp1251"]],
  ["windows-1253", ["windows-1253", "cp1253"]],
  ["windows-1254", ["windows-1254", "cp1254", "iso-8859-9", "latin5"]],
  ["windows-1257", ["windows-1257", "cp1257"]],
  ["iso-8859-2", ["iso-8859-2", "latin2", "l2"]],
  ["iso-8859-5", ["iso-8859-5", "cyrillic"]],
  ["iso-8859-15", ["iso-8859-15", "latin9", "l9"]],
  ["koi8-r", ["koi8-r", "koi8", "koi"]],
  ["koi8-u", ["koi8-u"]],
];

const LABEL_TO_ENCODING = new Map<string, string>();
for (const [encoding, labels] of CODECS) {
  for (const label of labels) LABEL_TO_ENCODING.set(label, encoding);
}

/** The encoding a page declares through a UTF-16 BOM or a <meta> tag, or null. */
export function declaredEncoding(raw: Uint8Array): string | null {
  if (raw[0] === 0xff && raw[1] === 0xfe) return "utf-16le";
  if (raw[0] === 0xfe && raw[1] === 0xff) return "utf-16be";
  const head = Buffer.from(raw.subarray(0, PRESCAN_BYTES)).toString("latin1");
  const match = META_CHARSET.exec(head);
  if (!match) return null;
  return LABEL_TO_ENCODING.get((match[1] as string).toLowerCase()) ?? null;
}

/** Text of a saved page: UTF-8 when valid, else its declared charset, else UTF-8 with replacement. */
export function decodePage(raw: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    // fall through to the declared charset
  }
  const encoding = declaredEncoding(raw) ?? "utf-8";
  try {
    return new TextDecoder(encoding).decode(raw);
  } catch {
    return new TextDecoder("utf-8").decode(raw);
  }
}
