package kiro

const (
	CompletionToolName          = "codex_kiro_final_answer"
	ContinuationMessage         = "[system: conversation continues]"
	CompletionRetryMessage      = "[system: The preceding assistant output did not explicitly complete the turn. If the task is complete, call " + CompletionToolName + " now with the complete final answer. Otherwise issue the next real tool call now. Do not ask the user for another task or emit another progress-only message.]"
	CompletionInstructions      = "When tools are available, ordinary assistant text is mid-task commentary and does not end the turn. Continue using tools after progress updates. When the task is fully complete and no more tool calls are needed, call " + CompletionToolName + " exactly once with the complete user-facing final answer in `answer`. Do not provide the final answer as ordinary assistant text."
	MaxInjectedInstructionChars = 16_384
	ImageBase64Budget           = 18 * 1024 * 1024
	MaxImagesPerMessage         = 20
)

type CompletionMode string

const (
	CompletionDisabled     CompletionMode = "disabled"
	CompletionRequired     CompletionMode = "required"
	CompletionTextFallback CompletionMode = "text_fallback"
)
