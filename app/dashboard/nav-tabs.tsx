"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard", label: "Leads" },
  { href: "/dashboard/guide", label: "Roadmap Guide" },
];

export function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1">
      {TABS.map((tab) => {
        const active =
          tab.href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? "rounded-lg bg-[#337a80]/10 px-3 py-1.5 text-sm font-semibold text-[#1a4245] dark:bg-teal-900/40 dark:text-teal-100"
                : "rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
