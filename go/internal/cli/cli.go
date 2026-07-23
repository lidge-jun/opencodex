package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

const Version = "0.1.0-dev"

type IO struct {
	In  io.Reader
	Out io.Writer
	Err io.Writer
}

type Command struct {
	Name string
	Args []string
}

func Parse(args []string) (Command, error) {
	if len(args) == 0 {
		return Command{Name: "help"}, nil
	}
	name := strings.ToLower(strings.TrimSpace(args[0]))
	if name == "-h" || name == "--help" {
		name = "help"
	}
	if name == "-v" || name == "--version" || name == "version" {
		name = "version"
	}
	if strings.HasPrefix(name, "-") {
		return Command{}, fmt.Errorf("unknown option %q", args[0])
	}
	return Command{Name: name, Args: append([]string(nil), args[1:]...)}, nil
}

// Dispatch executes os.Args and returns a process exit code.
func Dispatch() int {
	return Run(context.Background(), os.Args[1:], IO{In: os.Stdin, Out: os.Stdout, Err: os.Stderr})
}

func Run(ctx context.Context, args []string, streams IO) int {
	command, err := Parse(args)
	if err != nil {
		fmt.Fprintln(streams.Err, "Error:", err)
		return 2
	}
	var runErr error
	switch command.Name {
	case "help":
		runErr = PrintHelp(streams.Out, first(command.Args))
	case "version":
		fmt.Fprintf(streams.Out, "opencodex %s\n", Version)
	case "serve", "start":
		runErr = runServe(ctx, command.Args, streams)
	case "account":
		runErr = runAccount(ctx, command.Args, streams)
	case "provider":
		runErr = runProvider(command.Args, streams)
	case "models":
		runErr = runModels(command.Args, streams)
	case "init":
		runErr = runInit(command.Args, streams)
	case "status":
		runErr = runStatus(ctx, command.Args, streams)
	case "doctor":
		runErr = runDoctor(ctx, command.Args, streams)
	case "claude":
		runErr = runClaude(ctx, command.Args, streams)
	case "debug":
		runErr = runDebug(command.Args, streams)
	case "service":
		runErr = runService(command.Args, streams)
	case "update":
		runErr = runUpdate(ctx, command.Args, streams)
	default:
		fmt.Fprintf(streams.Err, "Unknown command: %s\n", command.Name)
		_ = PrintHelp(streams.Err, "")
		return 2
	}
	if runErr != nil {
		fmt.Fprintln(streams.Err, "Error:", runErr)
		return 1
	}
	return 0
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
