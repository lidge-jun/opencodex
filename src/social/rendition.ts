import { computeContentHash } from "./content-hash";
import type {
  SocialAccount,
  SocialPublication,
  SocialPublicationAsset,
  SocialRendition,
} from "./types";

export interface GenerateRenditionsInput {
  publication: SocialPublication;
  targetAccounts: SocialAccount[];
  assets?: SocialPublicationAsset[];
}

export function generateRenditions(input: GenerateRenditionsInput): SocialRendition[] {
  const { publication, targetAccounts, assets = [] } = input;
  const renditions: SocialRendition[] = [];
  const mediaSha256s = assets.map(a => a.sha256);

  for (const account of targetAccounts) {
    const caps = account.capabilities;
    const maxLen = caps.text?.max_length ?? 280;

    // Adapt master caption to platform length
    let caption = publication.master_caption ?? "";
    if (caption.length > maxLen) {
      // Truncate gracefully if needed
      caption = caption.slice(0, maxLen - 3) + "…";
    }

    // Format hashtags
    const hashtags = [...publication.master_tags];

    // Determine platform format
    let format = "text";
    const hasVideo = assets.some(a => a.mime_type.startsWith("video/"));
    const hasImage = assets.some(a => a.mime_type.startsWith("image/"));
    if (hasVideo && caps.media.video.allowed) {
      format = "video";
    } else if (hasImage && caps.media.image.allowed) {
      format = assets.length > 1 ? "multi_image" : "single_image";
    }

    const title = caps.text.title ? (publication.master_title ?? null) : null;
    const description = caps.text.description ? (publication.master_description ?? null) : null;

    const contentHash = computeContentHash({
      caption,
      title,
      description,
      hashtags,
      mediaSha256s,
      platform: account.platform,
      accountRef: account.openpost_account_ref,
      providerSettings: {},
      scheduledAt: publication.scheduled_at,
      policyVersion: "20.60.1",
    });

    renditions.push({
      id: `rend_${publication.id}_${account.id}`,
      publication_id: publication.id,
      account_id: account.id,
      platform: account.platform,
      format,
      title,
      caption,
      description,
      hashtags,
      provider_settings: {},
      capability_snapshot: caps,
      validation_status: "pending",
      approval_status: "pending",
      delivery_status: "draft",
      openpost_publication_ref: null,
      openpost_rendition_ref: null,
      scheduled_at: publication.scheduled_at,
      content_hash: contentHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return renditions;
}

