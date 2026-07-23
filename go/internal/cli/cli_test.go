package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestParseDefaultsToHelp(t *testing.T) {
	command, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	if command.Name != "help" || len(command.Args) != 0 {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestParsePreservesSubcommandArguments(t *testing.T) {
	command, err := Parse([]string{"provider", "add", "openrouter", "--model", "x"})
	if err != nil {
		t.Fatal(err)
	}
	if command.Name != "provider" || strings.Join(command.Args, " ") != "add openrouter --model x" {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestRunVersionAndUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	streams := IO{In: strings.NewReader(""), Out: &out, Err: &errOut}
	if code := Run(context.Background(), []string{"--version"}, streams); code != 0 {
		t.Fatalf("version exit=%d", code)
	}
	if !strings.Contains(out.String(), "opencodex "+Version) {
		t.Fatalf("version output: %q", out.String())
	}
	out.Reset()
	errOut.Reset()
	if code := Run(context.Background(), []string{"unknown"}, streams); code != 2 {
		t.Fatalf("unknown exit=%d", code)
	}
	if !strings.Contains(errOut.String(), "Unknown command") {
		t.Fatalf("unknown output: %q", errOut.String())
	}
}
