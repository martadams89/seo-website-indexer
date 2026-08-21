import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricChart, Sparkline } from "./Charts";

describe("accessible charts", () => {
  it("gives a metric chart a concise textual name and range", () => {
    render(
      <MetricChart
        label="Organic clicks"
        points={[
          { date: "2026-08-01", value: 12 },
          { date: "2026-08-02", value: 18 },
        ]}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "Organic clicks",
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "2026-08-02 at 18",
    );
  });

  it("keeps decorative sparklines out of the accessibility tree", () => {
    const { container } = render(<Sparkline points={[1, 2, 3]} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });
});
