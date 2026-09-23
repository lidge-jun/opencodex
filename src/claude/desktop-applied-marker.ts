import { mutatePersistedConfig, type PersistedConfigMutationOutcome } from "../config";
import { emptyDesktopProfile, sameProfileContent, type DesktopProfile } from "./desktop-profile";

export interface DesktopAppliedMarkerBaseline {
  profile: DesktopProfile | undefined;
  appliedFingerprint: string | undefined;
  appliedAt: string | undefined;
}

export function captureDesktopAppliedMarker(
  profile: DesktopProfile | undefined,
): DesktopAppliedMarkerBaseline {
  const snapshot = profile == null ? undefined : structuredClone(profile);
  return {
    profile: snapshot,
    appliedFingerprint: snapshot?.appliedFingerprint,
    appliedAt: snapshot?.appliedAt,
  };
}

export function commitDesktopAppliedMarker(
  baseline: DesktopAppliedMarkerBaseline,
  fingerprint: string,
): PersistedConfigMutationOutcome<boolean> {
  const appliedAt = new Date().toISOString();
  return mutatePersistedConfig<boolean>(persisted => {
    const profile = persisted.claudeCode?.desktopProfile;
    if ((profile == null) !== (baseline.profile === undefined)
      || (profile && baseline.profile && !sameProfileContent(profile, baseline.profile))
      || profile?.appliedFingerprint !== baseline.appliedFingerprint
      || profile?.appliedAt !== baseline.appliedAt) {
      return { changed: false, value: false };
    }
    persisted.claudeCode = {
      ...(persisted.claudeCode ?? {}),
      desktopProfile: {
        ...(profile ?? emptyDesktopProfile()),
        appliedFingerprint: fingerprint,
        appliedAt,
      },
    };
    return { changed: true, value: true };
  });
}
