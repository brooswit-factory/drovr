/** Only local drive-absolute paths. Reject Win32 aliases before normalization. */
export function windowsPathParts(path: string): { root: string; parts: string[] } {
  if (!/^[a-z]:[\\/]/i.test(path) || path.includes("\0")) throw new Error("Native transcript: an absolute path on a local Windows drive is required");
  const parts = path.slice(3).split(/[\\/]/).filter(Boolean);
  for (const part of parts) {
    if (part === "..") throw new Error("Native transcript: an absolute path without parent traversal is required");
    if (part === "." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error("Native transcript: unsafe Windows path component");
    }
  }
  return { root: `\\\\?\\${path.slice(0, 2)}\\`, parts };
}
