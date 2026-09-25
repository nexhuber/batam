import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Batam Dashboard",
  description: "Next.js, Lark SSO and BigQuery skeleton",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
