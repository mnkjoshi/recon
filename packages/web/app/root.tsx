import { Suspense } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { HexclaveProvider, HexclaveTheme } from "@hexclave/react";
import { hexclaveClientApp, hexclaveConfigured } from "./lib/auth";
import { ToastProvider } from "./components/Toasts";
import appCss from "./app.css?url";
import type { Route } from "./+types/root";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap",
  },
  { rel: "stylesheet", href: appCss },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Recon</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Hexclave's `useXyz` hooks suspend, so the whole tree sits inside a
 * Suspense boundary. Theme tokens are matched to Recon's own token system —
 * Hexclave drop-in components are used only for auth surfaces.
 */
const hexclaveTheme = {
  radius: "6px",
  colors: {
    light: {
      background: "#0f1216",
      foreground: "#e8ecf1",
      card: "#1a1f26",
      cardForeground: "#e8ecf1",
      primary: "#e8a33d",
      primaryForeground: "#0f1216",
      secondary: "#1a1f26",
      secondaryForeground: "#e8ecf1",
      muted: "#1a1f26",
      mutedForeground: "#8a94a3",
      border: "#2a313b",
      input: "#2a313b",
      ring: "#4fc1ce",
    },
    dark: {
      background: "#0f1216",
      foreground: "#e8ecf1",
      card: "#1a1f26",
      cardForeground: "#e8ecf1",
      primary: "#e8a33d",
      primaryForeground: "#0f1216",
      secondary: "#1a1f26",
      secondaryForeground: "#e8ecf1",
      muted: "#1a1f26",
      mutedForeground: "#8a94a3",
      border: "#2a313b",
      input: "#2a313b",
      ring: "#4fc1ce",
    },
  },
};

export default function App() {
  const inner = (
    <ToastProvider>
      <Suspense fallback={<div className="empty-state">Loading…</div>}>
        <Outlet />
      </Suspense>
    </ToastProvider>
  );
  if (hexclaveConfigured && hexclaveClientApp) {
    return (
      <HexclaveProvider app={hexclaveClientApp}>
        <HexclaveTheme theme={hexclaveTheme}>{inner}</HexclaveTheme>
      </HexclaveProvider>
    );
  }
  return inner;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong.";
  let detail = "";
  if (isRouteErrorResponse(error)) {
    message = `${error.status} ${error.statusText}`;
    detail = typeof error.data === "string" ? error.data : "";
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <div className="empty-state">
      <h2>{message}</h2>
      {detail ? <p className="muted">{detail}</p> : null}
      <p>
        <a href="/">Back to sessions</a>
      </p>
    </div>
  );
}
