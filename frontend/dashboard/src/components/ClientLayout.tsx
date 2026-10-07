"use client";

import { useEffect } from "react";
import SideNav from "./SideNav";

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (
      "serviceWorker" in navigator &&
      process.env.NODE_ENV === "production"
    ) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => console.log("SW registered:", reg.scope))
        .catch((err) => console.error("SW registration failed:", err));
    }
  }, []);

  return (
    <div className="flex min-h-screen">
      <SideNav />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
    </div>
  );
}
