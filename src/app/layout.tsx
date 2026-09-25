import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Batam News",
  description: "Dòng thời gian tin tức Batam",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
