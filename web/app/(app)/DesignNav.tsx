"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import s from "./DesignNav.module.css";

const LINKS = [
  { href: "/report", label: "Report" },
  { href: "/atlas", label: "Atlas" },
  { href: "/dossier", label: "Dossier" },
  { href: "/leads", label: "Index" },
];

export default function DesignNav() {
  const pathname = usePathname();
  return (
    <nav className={s.bar} aria-label="Dashboard design directions">
      <Link href="/" className={s.home} aria-label="MotivatedSignal home">
        MotivatedSignal
      </Link>
      <span className={s.divider} aria-hidden="true" />
      <ul className={s.list}>
        {LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                className={active ? `${s.link} ${s.active}` : s.link}
                aria-current={active ? "page" : undefined}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
