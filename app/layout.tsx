import type { Metadata, Viewport } from "next";
import { FONT_VARIABLES } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fusion",
  description: "Fuse your photos into posters, hero sections and loud backgrounds. Runs entirely in your browser.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={FONT_VARIABLES}>
      <body>{children}</body>
    </html>
  );
}
