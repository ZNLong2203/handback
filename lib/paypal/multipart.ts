import { createHash } from "node:crypto";

/**
 * multipart/form-data built by hand, so the request matches PayPal's own curl
 * examples (`-F 'input={...};type=application/json' -F 'file1=@doc.pdf'`):
 * the JSON part has a Content-Type and no filename. FormData would send a
 * JSON Blob with `filename="blob"`, which turns it into a file upload.
 *
 * The body is encoded once per request, so a retry sends identical bytes,
 * and the boundary comes from a hash of the parts, so the same parts always
 * give the same body.
 */
export type MultipartPart =
  | { name: string; json: unknown }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

export type MultipartBody = { contentType: string; body: Uint8Array };

const CRLF = "\r\n";
const SAFE_TOKEN = /^[A-Za-z0-9 ._,()-]+$/;
const SAFE_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;

function partBytes(p: MultipartPart): Uint8Array {
  return "json" in p ? new TextEncoder().encode(JSON.stringify(p.json)) : p.bytes;
}

/** A boundary that depends only on the content: same parts, same body. */
export function boundaryFor(parts: MultipartPart[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p.name);
    h.update("filename" in p ? `${p.filename}|${p.contentType}` : "json");
    h.update(partBytes(p));
  }
  return `handback-${h.digest("hex").slice(0, 32)}`;
}

function header(p: MultipartPart): string {
  if (!SAFE_TOKEN.test(p.name)) throw new RangeError(`unsafe multipart field name: ${JSON.stringify(p.name)}`);
  if ("json" in p) return `Content-Disposition: form-data; name="${p.name}"${CRLF}Content-Type: application/json${CRLF}${CRLF}`;
  if (!SAFE_TOKEN.test(p.filename)) throw new RangeError(`unsafe multipart filename: ${JSON.stringify(p.filename)}`);
  if (!SAFE_TYPE.test(p.contentType)) throw new RangeError(`unsafe content type: ${JSON.stringify(p.contentType)}`);
  return `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}Content-Type: ${p.contentType}${CRLF}${CRLF}`;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(Buffer.from(needle)) !== -1;
}

/** Encodes the parts as one multipart/form-data body (RFC 7578). */
export function encodeMultipart(parts: MultipartPart[], boundary = boundaryFor(parts)): MultipartBody {
  if (parts.length === 0) throw new RangeError("a multipart body needs at least one part");
  if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary)) throw new RangeError("invalid multipart boundary");
  const enc = new TextEncoder();
  const delimiter = enc.encode(`--${boundary}`);
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const bytes = partBytes(p);
    if (contains(bytes, delimiter)) throw new RangeError("multipart boundary occurs inside a part");
    chunks.push(enc.encode(`--${boundary}${CRLF}${header(p)}`), bytes, enc.encode(CRLF));
  }
  chunks.push(enc.encode(`--${boundary}--${CRLF}`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: new Uint8Array(Buffer.concat(chunks)) };
}
