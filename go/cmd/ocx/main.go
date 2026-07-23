package main

import (
	"os"

	"github.com/lidge-jun/opencodex-go/internal/cli"
)

func main() {
	os.Exit(cli.Dispatch())
}
