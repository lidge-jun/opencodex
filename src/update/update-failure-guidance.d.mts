export function npmUpdateFailureGuidance(failure: {
  phase?: string;
  rolledBack?: boolean;
  pkgName: string;
  version?: string;
  tag?: string;
}): { previousVersionKept: boolean; lines: string[] };
export const GUI_UPDATE_FAILURE_NEXT_STEP: string;
