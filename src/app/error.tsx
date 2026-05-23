"use client";

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Root ErrorBoundary caught:", error); }, [error]);
  return (
    <html lang="ar" dir="rtl">
      <body className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="max-w-md text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10 text-3xl">!</div>
          </div>
          <h1 className="mb-2 text-xl font-bold text-foreground">Something went wrong</h1>
          <p className="mb-6 text-muted-foreground">The application encountered an unexpected error. Please try refreshing.</p>
          <button onClick={reset} className="rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
