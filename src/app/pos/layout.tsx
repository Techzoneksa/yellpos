import Link from "next/link";

export default function POSLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#FFD60A] text-xs font-bold text-[#1A1814]">
            YC
          </div>
          <span className="text-sm font-semibold text-foreground">Yellow Chicken POS</span>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/pos" className="text-muted-foreground hover:text-foreground">POS</Link>
          <Link href="/pos/open-shift" className="text-muted-foreground hover:text-foreground">Open Shift</Link>
          <Link href="/pos/recent-orders" className="text-muted-foreground hover:text-foreground">Orders</Link>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
