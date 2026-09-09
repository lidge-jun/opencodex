// Command ocx is the Go CLI scaffold for the incremental runtime takeover.
package main

import (
	"os"

	"github.com/lidge-jun/opencodex/go/internal/ocxcli"
)

// version is set by release builds with -ldflags '-X main.version=<package version>'.
var version string

func main() { os.Exit(ocxcli.Run(os.Args[1:], ocxcli.Deps{Version: resolveVersion()})) }
func resolveVersion() string {
	if version != "" {
		return version
	}
	return "dev"
}
