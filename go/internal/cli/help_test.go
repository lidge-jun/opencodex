package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestHelpOutputListsLifecycleAndManagementCommands(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, ""); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"ocx serve", "ocx service", "ocx provider", "ocx account", "ocx models", "ocx claude"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("help missing %q", expected)
		}
	}
}

func TestSubcommandHelp(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, "service"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "install|start|stop|status|uninstall") {
		t.Fatalf("unexpected help: %q", output.String())
	}
}
