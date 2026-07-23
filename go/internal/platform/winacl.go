//go:build windows

package platform

import (
	"fmt"
	"os/exec"
	"os/user"
)

// HardenSecretPath removes inherited ACLs and grants the current user full control.
func HardenSecretPath(path string, directory bool) error {
	inheritance := "/inheritance:r"
	current, err := user.Current()
	if err != nil || current.Username == "" {
		return fmt.Errorf("resolve current Windows user: %w", err)
	}
	grant := current.Username + ":(F)"
	if directory {
		grant = current.Username + ":(OI)(CI)(F)"
	}
	command := exec.Command("icacls.exe", path, inheritance, "/grant:r", grant, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)")
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("harden ACL: %w: %s", err, output)
	}
	return nil
}
