// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";

vi.mock("../app/lib/api", () => ({
  listSessions: vi.fn(async () => ({
    sessions: [
      {
        id: "s_1",
        name: "payments refactor",
        team_id: "t1",
        created_by: "u1",
        created_by_name: "Alice",
        created_at: 1700000000000,
        model_id: "mock",
        system_prompt: "",
        current_branch: "main",
        branch_count: 3,
        online: 2,
        last_activity: 1700000100000,
      },
    ],
  })),
  createSession: vi.fn(),
}));

import Home, { clientLoader } from "../app/routes/home";

describe("route smoke", () => {
  it("session browser lists sessions repo-style", async () => {
    const loaderData = await clientLoader({} as never);
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => <Home loaderData={loaderData} params={{}} matches={[] as never} />,
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("payments refactor")).toBeTruthy();
    expect(screen.getByText("3 branches")).toBeTruthy();
    expect(screen.getByText("2 online")).toBeTruthy();
    expect(screen.getByText("Start a session")).toBeTruthy();
  });

  it("shows the empty-state invitation when there are no sessions", async () => {
    const api = await import("../app/lib/api");
    (api.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sessions: [] });
    const loaderData = await clientLoader({} as never);
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => <Home loaderData={loaderData} params={{}} matches={[] as never} />,
      },
    ]);
    render(<Stub initialEntries={["/"]} />);
    expect(await screen.findByText("Start a session to begin.")).toBeTruthy();
  });
});
