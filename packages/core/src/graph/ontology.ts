/**
 * Ontology: re-exports the frozen node/edge types and gives loose prop typings
 * for the JSON `props` column per node type. These are conventions, not
 * enforced by SQLite — the CHECK constraints only guard the type discriminator.
 */
export type { NodeType, EdgeType } from '../contracts.js';

export interface FileProps {
  path: string;
  sizeBytes?: number;
  mtimeMs?: number;
  atimeMs?: number;
  ext?: string;
  hash?: string;
}

export interface DirectoryProps {
  path: string;
  approxBytes?: number;
}

export interface VolumeProps {
  mount: string;
  fsType?: string;
  label?: string;
  sizeBytes?: number;
  usedBytes?: number;
  isSSD?: boolean | null;
}

export interface ApplicationProps {
  name: string;
  version?: string | null;
  publisher?: string | null;
  installPath?: string | null;
  bundleId?: string | null;
  uninstallString?: string | null;
  platform?: 'darwin' | 'win32';
}

export interface ProcessProps {
  pid: number;
  name: string;
  command?: string;
  cpuPercent?: number;
  memBytes?: number;
  user?: string | null;
  started?: string | null;
}

export interface CacheLocationProps {
  path: string;
  kind: string; // 'user-cache' | 'logs' | 'tmp' | 'trash' | 'browser-cache' | ...
  browser?: string;
}

export interface UserProps {
  username: string;
  home?: string;
}

export type NodePropsByType = {
  File: FileProps;
  Directory: DirectoryProps;
  Volume: VolumeProps;
  Application: ApplicationProps;
  Process: ProcessProps;
  CacheLocation: CacheLocationProps;
  User: UserProps;
};
