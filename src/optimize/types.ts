export type PonytailLevel = "lite" | "full" | "ultra";

export interface OptimizeConfig {
  rtkEnabled?: boolean;
  headroomEnabled?: boolean;
  headroomUrl?: string;
  headroomTimeoutMs?: number;
  ponytailEnabled?: boolean;
  ponytailLevel?: PonytailLevel;
}

export interface RtkHit {
  shape?: string;
  filter: string;
  saved: number;
}

export interface RtkStats {
  bytesBefore: number;
  bytesAfter: number;
  hits: RtkHit[];
}

export type FilterFunction = (input: string) => string;
