package ocxcli

import (
	"flag"
	"fmt"
	"net"
	"net/http"

	"github.com/lidge-jun/opencodex/go/internal/embeddedui"
)

func runEmbeddedDashboard(args []string, deps Deps) int {
	flags := flag.NewFlagSet("serve-dashboard", flag.ContinueOnError)
	flags.SetOutput(deps.Stderr)
	listen := flags.String("listen", "127.0.0.1:10100", "listener address")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		fmt.Fprintln(deps.Stderr, "Usage: ocx serve-dashboard [--listen <host:port>]")
		return ExitUsage
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	defer listener.Close()
	fmt.Fprintf(deps.Stdout, "OpenCodex embedded dashboard listening on http://%s\n", listener.Addr())
	if err := http.Serve(listener, embeddedui.NewHandler(deps.Version)); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(deps.Stderr, err)
		return ExitFailure
	}
	return ExitOK
}
