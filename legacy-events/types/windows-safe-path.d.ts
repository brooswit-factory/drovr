/** Only local drive-absolute paths. Reject Win32 aliases before normalization. */
export declare function windowsPathParts(path: string): {
    root: string;
    parts: string[];
};
