import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-64 flex-col border-l border-border bg-card p-4">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#FFD60A] text-xs font-bold text-[#1A1814]">
            YC
          </div>
          <span className="text-sm font-semibold text-foreground">Dashboard</span>
        </div>
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/dashboard" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Overview</Link>
          <Link href="/dashboard/products" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Products</Link>
          <Link href="/dashboard/categories" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Categories</Link>
          <Link href="/dashboard/addons" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Add-ons</Link>
          <Link href="/dashboard/users" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Users</Link>
          <Link href="/dashboard/customers" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Customers</Link>
          <Link href="/dashboard/shifts" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Shifts</Link>
          <Link href="/dashboard/reports" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Reports</Link>
          <Link href="/dashboard/suppliers" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Suppliers</Link>
          <Link href="/dashboard/purchases" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Purchases</Link>
          <Link href="/dashboard/inventory" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Inventory</Link>
          <Link href="/dashboard/recipes" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Recipes</Link>
          <Link href="/dashboard/expenses" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Expenses</Link>
          <Link href="/dashboard/finance" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Finance</Link>
          <Link href="/dashboard/payroll" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Payroll</Link>
          <Link href="/dashboard/audit" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Audit</Link>
          <Link href="/dashboard/zatca" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">ZATCA</Link>
          <Link href="/dashboard/settings" className="rounded-md px-3 py-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground">Settings</Link>
        </nav>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
