import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1e3a8a 0%, #0d9488 55%, #059669 100%)",
          color: "#ffffff",
        }}
      >
        <div
          style={{
            width: 112,
            height: 112,
            borderRadius: "9999px",
            border: "8px solid rgba(255, 255, 255, 0.92)",
            background: "rgba(255, 255, 255, 0.14)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 72,
            fontWeight: 900,
          }}
        >
          $
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}

