import { describe, expect, test } from "bun:test";
import { defaultSocketPath } from "@brooswit/herdr-sdk";

describe("@brooswit/herdr-sdk dependency", () => {
  test("defaultSocketPath honors HERDR_SOCKET when set", () => {
    expect(defaultSocketPath({ HERDR_SOCKET: "/tmp/custom.sock" })).toBe("/tmp/custom.sock");
  });

  test("defaultSocketPath falls back to ~/.config/herdr/herdr.sock", () => {
    expect(defaultSocketPath({ HOME: "/home/example" })).toBe(
      "/home/example/.config/herdr/herdr.sock",
    );
  });
});
