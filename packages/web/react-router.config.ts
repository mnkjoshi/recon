import type { Config } from "@react-router/dev/config";

export default {
  // SPA mode: tokens live in the browser (Hexclave cookie token store), so
  // all data loading happens in clientLoaders against the engine server.
  ssr: false,
} satisfies Config;
