import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Butchr's default lizard-mode approval sound (FACTORY-100/FACTORY-103) resolves
// this file from the installed @brooswit/drovr package. If a future edit drops
// the asset, shrinks it to empty, or removes "assets" from package.json `files`,
// the published tarball silently stops shipping a sound Butchr already depends on.
const assetUrl = new URL("../assets/sounds/lizard-button.mp3", import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  files?: string[];
};

describe("bundled lizard-button.mp3 approval-sound asset", () => {
  test("exists, is non-empty, and starts with MP3 magic", () => {
    const bytes = readFileSync(assetUrl);
    expect(bytes.length).toBeGreaterThan(0);

    const isId3Tag = bytes.subarray(0, 3).equals(Buffer.from("ID3", "ascii"));
    const isMpegFrameSync = bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
    expect(isId3Tag || isMpegFrameSync).toBe(true);
  });

  test("package.json `files` covers `assets`", () => {
    expect(packageJson.files).toContain("assets");
  });
});
