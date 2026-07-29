import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RangeSlider } from "./RangeSlider";

describe("RangeSlider", () => {
  it("updates handles and restores the full range", () => {
    const onChange = vi.fn();
    render(<RangeSlider min={0} max={10} from={2} to={8} onChange={onChange} startLabel="开始" endLabel="结束" />);
    expect(screen.getByRole("button", { name: "恢复完整范围" })).toBeEnabled();
    fireEvent.change(screen.getByRole("slider", { name: "开始" }), { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith(4, 8);
    fireEvent.click(screen.getByRole("button", { name: "恢复完整范围" }));
    expect(onChange).toHaveBeenCalledWith(0, 10);
  });
});
