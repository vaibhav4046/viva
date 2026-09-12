import { ImageResponse } from "next/og";

/**
 * The link preview: 1200×630, generated at build time from the same words and
 * the same palette as the hero. No committed raster, nothing to fall out of
 * date with the page.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "VIVA — study out loud, VIVA remembers";

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
          background: "#0b0b0c",
          padding: "0 88px",
          position: "relative",
        }}
      >
        {/* One soft pool of lime light, mirroring the hero. */}
        <div
          style={{
            position: "absolute",
            top: 60,
            left: 300,
            width: 700,
            height: 700,
            borderRadius: 350,
            background: "radial-gradient(circle, rgba(184,255,90,0.16) 0%, rgba(184,255,90,0.04) 40%, rgba(11,11,12,0) 70%)",
            display: "flex",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "#b8ff5a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0b0b0c",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            V
          </div>
          <div style={{ color: "#a7abb6", fontSize: 26, letterSpacing: 4 }}>VIVA</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", color: "#f2f0ea", fontSize: 84, fontWeight: 700, lineHeight: 1.1, letterSpacing: -3 }}>
          <div style={{ display: "flex" }}>Study out loud.</div>
          <div style={{ display: "flex" }}>VIVA remembers.</div>
        </div>

        <div style={{ display: "flex", marginTop: 36, color: "#d3d1c9", fontSize: 30, lineHeight: 1.4, maxWidth: 900 }}>
          The study partner you talk to. Built with the AssemblyAI Dictation API.
        </div>
      </div>
    ),
    size
  );
}
