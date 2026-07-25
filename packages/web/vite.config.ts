import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: mode === "test" ? [] : [reactRouter()],
  // Let the Hexclave CLI's injected HEXCLAVE_* vars reach the client bundle.
  envPrefix: ["VITE_", "HEXCLAVE_PROJECT_ID", "HEXCLAVE_PUBLISHABLE_CLIENT_KEY"],
  server: {
    port: 5173,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: false,
  },
}));
