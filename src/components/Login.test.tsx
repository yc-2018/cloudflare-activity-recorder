import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Login } from "./Login";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("Login", () => {
  it("submits a password and advances after a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, session: "signed-session" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const success = vi.fn();
    render(<Login onSuccess={success} />);
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem("activity_dashboard_session")).toBe("signed-session");
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
  });
});
