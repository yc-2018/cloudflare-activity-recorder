import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsLogin } from "./DetailsLogin";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("DetailsLogin", () => {
  it("uses the independent details login endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, detailsSession: "signed-details-session" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const success = vi.fn();
    render(<DetailsLogin onSuccess={success} />);

    fireEvent.change(screen.getByLabelText("采样明细密码"), { target: { value: "details-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "解锁明细" }));

    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem("activity_details_session")).toBe("signed-details-session");
    expect(fetch).toHaveBeenCalledWith("/api/auth/details/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ password: "details-secret" }),
    }));
  });
});
