import type { Metadata } from "next";
import "./globals.css";
import ClientLayout from "@/components/ClientLayout";

export const metadata: Metadata = {
  title: "Vanilla Monitor — Dashboard",
  description:
    "AI-powered vanilla plantation dashboard: disease detection, digital twin, growth forecasting, and recommendations.",
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-surface">
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
