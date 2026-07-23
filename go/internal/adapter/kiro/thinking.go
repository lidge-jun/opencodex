package kiro

import "strings"

type SplitEvent struct {
	Reasoning bool
	Text      string
}

type ThinkingSplitter struct {
	state    string
	pre      string
	thinking string
	closeTag string
}

var thinkingOpenTags = []string{"<thinking>", "<think>", "<reasoning>"}

func NewThinkingSplitter() *ThinkingSplitter { return &ThinkingSplitter{state: "pre"} }

func (p *ThinkingSplitter) Feed(text string) []SplitEvent {
	if text == "" {
		return nil
	}
	if p.state == "streaming" {
		return []SplitEvent{{Text: text}}
	}
	if p.state == "thinking" {
		p.thinking += text
		return p.drain()
	}
	p.pre += text
	stripped := strings.TrimLeft(p.pre, " \t\r\n")
	for _, tag := range thinkingOpenTags {
		if strings.HasPrefix(stripped, tag) {
			p.state = "thinking"
			p.closeTag = "</" + tag[1:]
			p.thinking = stripped[len(tag):]
			p.pre = ""
			return p.drain()
		}
	}
	for _, tag := range thinkingOpenTags {
		if len(stripped) < len(tag) && strings.HasPrefix(tag, stripped) {
			return nil
		}
	}
	p.state = "streaming"
	out := p.pre
	p.pre = ""
	return []SplitEvent{{Text: out}}
}

func (p *ThinkingSplitter) Flush() []SplitEvent {
	if p.state == "thinking" {
		out := p.thinking
		p.thinking = ""
		p.state = "streaming"
		if out != "" {
			return []SplitEvent{{Reasoning: true, Text: out}}
		}
	}
	if p.pre != "" {
		out := p.pre
		p.pre = ""
		p.state = "streaming"
		return []SplitEvent{{Text: out}}
	}
	return nil
}

func (p *ThinkingSplitter) drain() []SplitEvent {
	if idx := strings.Index(p.thinking, p.closeTag); idx >= 0 {
		reasoning := p.thinking[:idx]
		after := strings.TrimLeft(p.thinking[idx+len(p.closeTag):], " \t\r\n")
		p.thinking = ""
		p.state = "streaming"
		out := make([]SplitEvent, 0, 2)
		if reasoning != "" {
			out = append(out, SplitEvent{Reasoning: true, Text: reasoning})
		}
		if after != "" {
			out = append(out, SplitEvent{Text: after})
		}
		return out
	}
	maxClose := len("</reasoning>")
	if len(p.thinking) <= maxClose {
		return nil
	}
	cut := len(p.thinking) - maxClose
	out := p.thinking[:cut]
	p.thinking = p.thinking[cut:]
	return []SplitEvent{{Reasoning: true, Text: out}}
}
