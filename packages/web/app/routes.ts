import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("s/:session", "routes/session.tsx"),
  route("s/:session/branches", "routes/branches.tsx"),
  route("s/:session/turn/:turnId", "routes/turn.tsx"),
  // GitHub-compare style path `/compare/a...b` — parsed from the splat.
  route("s/:session/compare/*", "routes/compare.tsx"),
  route("s/:session/prune/:turnId", "routes/prune.tsx"),
] satisfies RouteConfig;
