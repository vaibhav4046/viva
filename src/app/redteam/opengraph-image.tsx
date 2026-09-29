import { ImageResponse } from "next/og";

/**
 * The /redteam link preview, 1200×630, in the review room's own palette: a
 * graphite field, one warm document surface, and the five verdicts as the
 * words and shapes the room uses. Generated at build time; nothing committed
 * that can drift from the page.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "VIVA RedTeam — rehearse the questions your document cannot answer";

const VERDICTS: { label: string; color: string }[] = [
  { label: "Supported", color: "#86c596" },
  { label: "Partial", color: "#e3ba5c" },
  { label: "Contradicted", color: "#f29a89" },
  { label: "Unsupported", color: "#bab4a7" },
  { label: "Unresolved", color: "#9fb2dc" },
];

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#101112", fontFamily: "Georgia, serif" }}>
        <div style={{ width: 700, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 56px 56px 72px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", color: "#b1b0a7", fontSize: 22, letterSpacing: 5 }}>VIVA REDTEAM</div>
            <div style={{ display: "flex", flexDirection: "column", color: "#ece8de", fontSize: 64, lineHeight: 1.06, marginTop: 28, letterSpacing: -1 }}>
              <div style={{ display: "flex" }}>Rehearse the questions</div>
              <div style={{ display: "flex" }}>your document</div>
              <div style={{ display: "flex" }}>cannot answer.</div>
            </div>
          </div>
          <div style={{ display: "flex", color: "#b1b0a7", fontSize: 24, lineHeight: 1.4 }}>
            A voice red-team for documents you have to defend. AssemblyAI Voice Agent.
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 64px 0 0" }}>
          <div style={{ display: "flex", flexDirection: "column", background: "#f1ebde", color: "#201e19", padding: "28px 28px 22px", borderLeft: "4px solid #8a2c1c" }}>
            <div style={{ display: "flex", fontSize: 22, lineHeight: 1.45 }}>“We automatically fail over to a replica.”</div>
            <div style={{ display: "flex", fontSize: 18, color: "#4a4538", marginTop: 14 }}>Document: “Automatic replica failover is not configured.”</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 28 }}>
            {VERDICTS.map((v) => (
              <div key={v.label} style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
                <div style={{ width: 16, height: 16, border: `3px solid ${v.color}`, background: v.label === "Supported" ? v.color : "transparent", display: "flex" }} />
                <div style={{ display: "flex", color: v.color, fontSize: 24, marginLeft: 14, fontFamily: "sans-serif" }}>{v.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    size
  );
}
