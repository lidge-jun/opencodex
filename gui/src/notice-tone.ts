export type NoticeTone = "ok" | "warn" | "err";

export type Notify = (message: string, tone?: NoticeTone) => void;
