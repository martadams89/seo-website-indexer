import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("labels the dialog, focuses its preferred control and closes on Escape", async () => {
    const close = vi.fn();
    render(
      <Modal
        title="Review deployment"
        description="Confirm the change"
        onClose={close}
      >
        <button data-autofocus>Approve</button>
      </Modal>,
    );

    expect(
      screen
        .getByRole("dialog", { name: "Review deployment" })
        .getAttribute("aria-describedby"),
    ).toBeTruthy();
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement?.textContent).toBe("Approve");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
  });
});
