// Command ocx is the Go CLI scaffold for the incremental runtime takeover.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/lidge-jun/opencodex/go/internal/ocxcli"
)

// version is set by release builds with -ldflags '-X main.version=<package version>'.
var version string

func main() { os.Exit(ocxcli.Run(os.Args[1:], ocxcli.Deps{Version: resolveVersion()})) }
func resolveVersion() string {
	if version != "" {
		return version
	}
	if value := os.Getenv("OCX_VERSION"); value != "" {
		return value
	}
	value, err := packageVersionFromWorkingTree()
	if err != nil {
		return "0.0.0"
	}
	return value
}
func packageVersionFromWorkingTree() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		value, err := packageVersionAt(dir)
		if err == nil {
			return value, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("package.json not found")
		}
		dir = parent
	}
}
