import { dlopen, ptr } from "bun:ffi";
import { windowsPathParts } from "./windows-safe-path";

// x64 Windows ABI. HANDLEs are integers, not Bun FFI pointers. All pathname
// components after the drive root are resolved relative to pinned handles.
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native transcript: Windows safe reader requires Windows x64");
const k = dlopen("kernel32.dll", {
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetFileType: { args: ["u64"], returns: "u32" },
  GetLastError: { args: [], returns: "u32" },
  GetFileInformationByHandleEx: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  SetFilePointerEx: { args: ["u64", "i64", "ptr", "u32"], returns: "i32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
}).symbols;
const nt = dlopen("ntdll.dll", {
  NtCreateFile: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"], returns: "i32" },
}).symbols;
const ACCESS = 0x100081; // SYNCHRONIZE | READ_ATTRIBUTES | READ_DATA/LIST_DIRECTORY
const REPARSE = 0x400;
function unsafe(code?: number): never {
  const error = new Error("Native transcript: path unavailable or unsafe (symlinks/reparse points are not allowed)") as NodeJS.ErrnoException;
  if (code === 2 || code === 3 || code === 0xc0000034 || code === 0xc000003a) error.code = "ENOENT";
  throw error;
}
function info(handle: bigint, type: number, size: number): Buffer {
  const data = Buffer.alloc(size);
  if (!k.GetFileInformationByHandleEx(handle, type, ptr(data), size)) unsafe(k.GetLastError());
  return data;
}
function verify(handle: bigint, directory: boolean): void {
  if (k.GetFileType(handle) !== 1) unsafe(); // FILE_TYPE_DISK
  const attributes = info(handle, 0, 40).readUInt32LE(32);
  if (attributes & REPARSE || (directory && !(attributes & 0x10))) unsafe();
}

export class WindowsSafeFile {
  private closed = false;
  constructor(private readonly handle: bigint) {}
  private live(): bigint { if (this.closed) throw new Error("Native transcript: handle is closed"); return this.handle; }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; if (!k.CloseHandle(this.handle)) unsafe(k.GetLastError()); } }
  async stat() {
    const handle = this.live();
    const basic = info(handle, 0, 40);
    const standard = info(handle, 1, 24);
    const size = Number(standard.readBigInt64LE(8));
    if (!Number.isSafeInteger(size) || size < 0) unsafe();
    return { size, mtimeMs: basic.readBigInt64LE(16), ctimeMs: basic.readBigInt64LE(24),
      isFile: () => standard[21] === 0 && !(basic.readUInt32LE(32) & REPARSE) };
  }
  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
    const handle = this.live();
    if (![offset, length, position].every(n => Number.isSafeInteger(n) && n >= 0) || offset + length > buffer.length) throw new RangeError("Invalid read range");
    if (!length) return { bytesRead: 0 };
    // Both calls are synchronous: no JS task can change the shared file cursor.
    if (!k.SetFilePointerEx(handle, BigInt(position), null, 0)) unsafe(k.GetLastError());
    const count = Buffer.alloc(4);
    if (!k.ReadFile(handle, ptr(buffer.subarray(offset, offset + length)), length, ptr(count), null)) unsafe(k.GetLastError());
    return { bytesRead: count.readUInt32LE(0) };
  }
  async *entries(): AsyncGenerator<{ name: string; isDirectory(): boolean }> {
    const buffer = Buffer.alloc(64 * 1024);
    let restart = true;
    while (true) {
      // FILE_ID_BOTH_DIR_INFO; enumeration stays on this handle, never a path.
      if (!k.GetFileInformationByHandleEx(this.live(), restart ? 11 : 10, ptr(buffer), buffer.length)) {
        const error = k.GetLastError();
        if (error === 18) return; // ERROR_NO_MORE_FILES
        unsafe(error);
      }
      restart = false;
      let offset = 0;
      while (true) {
        if (offset + 104 > buffer.length) unsafe();
        const next = buffer.readUInt32LE(offset);
        const attrs = buffer.readUInt32LE(offset + 56);
        const length = buffer.readUInt32LE(offset + 60);
        if (length % 2 || length === 0 || offset + 104 + length > buffer.length
          || (next !== 0 && (next % 8 || next < 104 + length || offset + next >= buffer.length))) unsafe();
        const name = buffer.toString("utf16le", offset + 104, offset + 104 + length);
        if (name !== "." && name !== "..") {
          if (/[\\/\0]/.test(name)) unsafe();
          yield { name, isDirectory: () => !!(attrs & 0x10) && !(attrs & REPARSE) };
        }
        if (!next) break;
        offset += next;
      }
    }
  }
  /** One component only: no path-based lookup can replace a pinned parent. */
  async child(name: string, directory: boolean): Promise<WindowsSafeFile> {
    if (windowsPathParts(`C:\\${name}`).parts.length !== 1 || /[\\/]/.test(name)) unsafe();
    const text = Buffer.from(name, "utf16le");
    if (text.length > 65532) unsafe();
    const unicode = Buffer.alloc(16);
    unicode.writeUInt16LE(text.length, 0); unicode.writeUInt16LE(text.length, 2);
    unicode.writeBigUInt64LE(BigInt(ptr(text)), 8);
    const attributes = Buffer.alloc(48);
    attributes.writeUInt32LE(48, 0); attributes.writeBigUInt64LE(this.live(), 8);
    attributes.writeBigUInt64LE(BigInt(ptr(unicode)), 16); attributes.writeUInt32LE(0x40, 24);
    const output = Buffer.alloc(8), status = Buffer.alloc(16);
    const result = nt.NtCreateFile(ptr(output), ACCESS, ptr(attributes), ptr(status), null, 0, 7, 1,
      0x200020 | (directory ? 1 : 0), null, 0); // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT
    if (result < 0) unsafe(result >>> 0);
    const handle = output.readBigUInt64LE(0);
    try { verify(handle, directory); return new WindowsSafeFile(handle); }
    catch (error) { k.CloseHandle(handle); throw error; }
  }
}

export async function openWindowsSafeFile(path: string, directory = false): Promise<WindowsSafeFile> {
  const { root, parts } = windowsPathParts(path);
  const rootText = Buffer.from(root + "\0", "utf16le");
  const value = BigInt(k.CreateFileW(ptr(rootText), ACCESS, 7, null, 3, 0x02200000, 0n));
  if (value === 0xffffffffffffffffn) unsafe(k.GetLastError());
  let handle = new WindowsSafeFile(value);
  try {
    verify(value, true);
    for (let i = 0; i < parts.length; i++) {
      const next = await handle.child(parts[i]!, directory || i < parts.length - 1);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
