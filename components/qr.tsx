import QRCode from "qrcode";

/** A QR code rendered on the server as inline SVG, so the counter can hand the customer their link. */
export async function Qr({ value, size = 148, label }: { value: string; size?: number; label: string }) {
  const svg = await QRCode.toString(value, { type: "svg", margin: 1, color: { dark: "#1d1b2f", light: "#ffffff" } });
  return (
    <div
      role="img"
      aria-label={label}
      className="overflow-hidden rounded-xl border border-line bg-white p-1.5"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
