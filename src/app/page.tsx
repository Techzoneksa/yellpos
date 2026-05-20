import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#FFD60A] text-3xl font-bold text-[#1A1814]">
            YC
          </div>
        </div>
        <h1 className="mb-2 text-3xl font-bold text-foreground">
          Yellow Chicken POS
        </h1>
        <p className="mb-8 text-muted-foreground">
          يلو تشكن — نظام نقاط البيع
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/pos/login"
            className="rounded-md bg-primary px-6 py-3 text-lg font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            نظام نقاط البيع / POS
          </Link>
          <Link
            href="/dashboard/login"
            className="rounded-md border border-input bg-background px-6 py-3 text-lg font-medium text-foreground transition-colors hover:bg-accent"
          >
            لوحة التحكم / Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
