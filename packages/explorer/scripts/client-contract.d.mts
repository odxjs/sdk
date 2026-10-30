export declare function listClientFiles(directory: string, prefix?: string): Promise<Record<string, string>>
export declare function getExplorerSourceHash(directory: string): Promise<string>
export declare function getWorkspaceLockHash(directory: string): Promise<string | null>
