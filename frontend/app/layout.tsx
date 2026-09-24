import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "Outbox Scheduler",
  description: "Schedule and send cold email campaigns at a controlled rate",
};

// suppressHydrationWarning is here because extensions such as Dark Reader inject
// attributes onto <html> before React hydrates. It applies to this element only,
// so genuine mismatches inside the tree still surface.
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
