export declare class WindowsSafeFile {
    private readonly handle;
    private closed;
    constructor(handle: bigint);
    private live;
    close(): Promise<void>;
    stat(): Promise<{
        size: number;
        mtimeMs: bigint;
        ctimeMs: bigint;
        isFile: () => boolean;
    }>;
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{
        bytesRead: number;
    }>;
    entries(): AsyncGenerator<{
        name: string;
        isDirectory(): boolean;
    }>;
    /** One component only: no path-based lookup can replace a pinned parent. */
    child(name: string, directory: boolean): Promise<WindowsSafeFile>;
}
export declare function openWindowsSafeFile(path: string, directory?: boolean): Promise<WindowsSafeFile>;
