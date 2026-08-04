import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpine Search",
  description: "Build plausible hiking routes inside a bounded trail graph.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
