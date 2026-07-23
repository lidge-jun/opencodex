package cli

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runUpdate(ctx context.Context, args []string, streams IO) error {
	flags := flag.NewFlagSet("update", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	url := flags.String("url", "", "HTTPS binary URL")
	sha := flags.String("sha256", "", "expected SHA-256")
	destination := flags.String("destination", "", "binary destination")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *url == "" || *sha == "" {
		return fmt.Errorf("--url and --sha256 are required")
	}
	if *destination == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*destination = executable
	}
	if err := platform.DownloadAndReplace(ctx, *url, *sha, *destination); err != nil {
		return err
	}
	fmt.Fprintf(streams.Out, "Updated %s.\n", *destination)
	return nil
}
