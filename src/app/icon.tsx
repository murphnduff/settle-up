import { ImageResponse } from "next/og";

export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "16px",
          background: "linear-gradient(135deg, #1e3a8a 0%, #0d9488 55%, #059669 100%)",
          color: "#ffffff",
          fontSize: 40,
          fontWeight: 900,
          letterSpacing: "-0.04em",
        }}
      >
        $
      </div>
    ),
    {
      ...size,
    }
  );
}

