import { describe, expect, it } from "vitest";
import { boundaryFor, encodeMultipart, type MultipartPart } from "./multipart";

const pdf = new TextEncoder().encode("%PDF-1.7 fake");
const parts: MultipartPart[] = [
  { name: "input", json: { evidences: [{ evidence_type: "OTHER", notes: "In-store rental" }] } },
  { name: "file1", filename: "R-ABC123-evidence.pdf", contentType: "application/pdf", bytes: pdf },
];

describe("encodeMultipart", () => {
  it("writes a JSON part without a filename and a file part with one, as curl -F does", () => {
    const { contentType, body } = encodeMultipart(parts, "XyZ");
    expect(contentType).toBe("multipart/form-data; boundary=XyZ");
    expect(Buffer.from(body).toString("latin1")).toBe(
      [
        "--XyZ",
        'Content-Disposition: form-data; name="input"',
        "Content-Type: application/json",
        "",
        '{"evidences":[{"evidence_type":"OTHER","notes":"In-store rental"}]}',
        "--XyZ",
        'Content-Disposition: form-data; name="file1"; filename="R-ABC123-evidence.pdf"',
        "Content-Type: application/pdf",
        "",
        "%PDF-1.7 fake",
        "--XyZ--",
        "",
      ].join("\r\n"),
    );
  });

  it("keeps binary file bytes exactly as given", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x0d, 0x0a, 0xff, 0xd9]);
    const { body } = encodeMultipart([{ name: "file1", filename: "photo.jpg", contentType: "image/jpeg", bytes }], "b");
    const buf = Buffer.from(body);
    const start = buf.indexOf("\r\n\r\n") + 4;
    expect([...buf.subarray(start, start + bytes.length)]).toEqual([...bytes]);
  });

  it("derives the boundary from the content, so the same parts give the same bytes", () => {
    expect(boundaryFor(parts)).toBe(boundaryFor(parts));
    expect(Buffer.from(encodeMultipart(parts).body).equals(Buffer.from(encodeMultipart(parts).body))).toBe(true);
    const other = [parts[0], { ...parts[1], bytes: new TextEncoder().encode("%PDF-1.7 other") }] as MultipartPart[];
    expect(boundaryFor(other)).not.toBe(boundaryFor(parts));
  });

  it("refuses header injection and a boundary that occurs in the content", () => {
    expect(() => encodeMultipart([{ name: 'input"; x="y', json: {} }])).toThrow(/field name/);
    expect(() => encodeMultipart([{ name: "f", filename: "a\r\nb.pdf", contentType: "application/pdf", bytes: pdf }])).toThrow(/filename/);
    expect(() => encodeMultipart([{ name: "input", json: { note: "--XyZ inside" } }], "XyZ")).toThrow(/boundary occurs/);
  });
});
