import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpine Search",
  description: "Build hiking routes inside a boundary you choose.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
