import { ImageResponse } from "next/og";

/**
 * The link preview: 1200x630, generated at build time from the same words and
 * the same palette as the landing page. Flat paper canvas, one serif headline,
 * no gradient. ImageResponse cannot read CSS variables, so the hex values below
 * are copies of --canvas, --text-primary, --text-secondary and --primary from
 * src/styles/tokens.css.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "VIVA: an oral exam on your own lecture notes";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#F1EDE4",
          padding: "0 88px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 6,
              background: "#1F2A3A",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#F8F5EE",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            V
          </div>
          <div style={{ color: "#4A463F", fontSize: 26, letterSpacing: 4 }}>VIVA</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", color: "#1D1B18", fontSize: 76, fontFamily: "serif", lineHeight: 1.12 }}>
          <div style={{ display: "flex" }}>Upload your lecture notes.</div>
          <div style={{ display: "flex" }}>Get examined on them out loud.</div>
        </div>

        <div style={{ display: "flex", marginTop: 36, color: "#4A463F", fontSize: 30, lineHeight: 1.4, maxWidth: 900 }}>
          Questions asked aloud, answers checked against your own pages.
        </div>
      </div>
    ),
    size
  );
}
