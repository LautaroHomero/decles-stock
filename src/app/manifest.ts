import type { MetadataRoute } from "next";

/** Instalable (PWA): ícono en la pantalla de inicio de la compu o el celular de la secretaría. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Klavdia · Stock",
    short_name: "Stock",
    description: "Stock, ventas y vencimientos del consultorio.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    lang: "es-AR",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
