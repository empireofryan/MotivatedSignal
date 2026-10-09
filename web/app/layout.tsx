import type { Metadata } from "next";
import { GeistSans as geistSans } from "geist/font/sans";
import { GeistMono as geistMono } from "geist/font/mono";
import Tracker from "../components/Tracker";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "MotivatedSignal",
    template: "%s · MotivatedSignal",
  },
  description:
    "Daily-refreshed motivated-seller leads for Maricopa County distress signals, ranked.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <Tracker />
        {children}
      </body>
    </html>
  );
}
