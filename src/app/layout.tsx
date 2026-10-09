import type { Metadata, Viewport } from "next";
import { Figtree, Unbounded } from "next/font/google";
import "./globals.css";

const figtree = Figtree({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-figtree" });
// Fuente de marca (wordmark кlavdia). El subset cyrillic es obligatorio (la к).
const unbounded = Unbounded({ subsets: ["latin", "cyrillic"], weight: ["500", "600"], variable: "--font-unbounded" });

export const metadata: Metadata = {
  title: "Klavdia · Stock",
  description: "Stock, ventas y vencimientos del consultorio.",
  appleWebApp: { capable: true, title: "Klavdia Stock", statusBarStyle: "black-translucent" },
  icons: { apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0c0c0d",
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

// Aplica el tema guardado antes del primer pintado (misma clave que Clavdia).
const THEME_BOOT = `try{var t=localStorage.getItem("clavdia_theme");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`h-full ${figtree.variable} ${unbounded.variable}`} data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
