/**
 * Which video job wire a bridge destination speaks, chosen by the plan's `VideoProviderAuth`.
 * The xAI wire finishes with a public `video.url` that the shared public-HTTPS downloader fetches;
 * the OpenAI wire finishes with bytes behind `/videos/{id}/content` on the same destination, read
 * with the same key. A destination never switches wire mid-call and never falls back to the other.
 */
import { downloadVideoToArtifact, type VideoBudget } from "./artifacts";
import { downloadOpenAiVideoToArtifact, pollOpenAiVideoJob, submitOpenAiVideoJob } from "./openai-video-client";
import { pollVideoJob, submitVideoJob, type VideoProviderAuth, type XaiVideoPollResult, type XaiVideoSubmitRequest } from "./xai-video-client";

export interface VideoWire {
  submit(req: XaiVideoSubmitRequest, auth: VideoProviderAuth, signal?: AbortSignal): Promise<{ requestId: string }>;
  poll(requestId: string, auth: VideoProviderAuth, signal?: AbortSignal): Promise<XaiVideoPollResult>;
  /** Whether a finished job must name a video URL. */
  requireUrl: boolean;
  /** Bring a finished job's video to an artifact file and return its path. */
  download(requestId: string, videoUrl: string | undefined, auth: VideoProviderAuth, budget: VideoBudget, signal: AbortSignal): Promise<string>;
}

const XAI_WIRE: VideoWire = {
  submit: (req, auth, signal) => submitVideoJob(req, auth, signal),
  poll: (requestId, auth, signal) => pollVideoJob(requestId, auth, signal),
  requireUrl: true,
  download: (_requestId, videoUrl, _auth, budget, signal) => {
    if (!videoUrl) return Promise.reject(new Error("video generation completed but no video URL was returned"));
    return downloadVideoToArtifact(videoUrl, budget, signal);
  },
};

const OPENAI_WIRE: VideoWire = {
  submit: (req, auth, signal) => submitOpenAiVideoJob(req, auth, signal),
  poll: (requestId, auth, signal) => pollOpenAiVideoJob(requestId, auth, signal),
  requireUrl: false,
  download: (requestId, _videoUrl, auth, budget, signal) => downloadOpenAiVideoToArtifact(requestId, auth, budget, signal),
};

export function videoWireFor(auth: Pick<VideoProviderAuth, "videoApi">): VideoWire {
  return auth.videoApi === "openai" ? OPENAI_WIRE : XAI_WIRE;
}
