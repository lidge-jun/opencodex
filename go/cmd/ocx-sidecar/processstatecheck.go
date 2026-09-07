package main

// The processstatecheck subcommand is the differential-oracle entry point for
// the Go process-state model (ticket #34). It calls the production parser and
// command-line matcher directly, so the Bun test cannot accidentally validate
// a second implementation of either security-sensitive rule.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/lidge-jun/opencodex/go/internal/ocxcli"
)

type processStateCheckInput struct {
	Parse []string `json:"parse"`
	Match []string `json:"match"`
}

type processStateCheckOutput struct {
	Parse []int64 `json:"parse"`
	Match []bool  `json:"match"`
}

func runProcessStateCheck() error {
	var raw []byte
	if len(os.Args) > 2 {
		raw = []byte(os.Args[2])
	} else {
		var err error
		raw, err = io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("processstatecheck: read stdin: %w", err)
		}
	}
	var input processStateCheckInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return fmt.Errorf("processstatecheck: decode input: %w", err)
	}
	output := processStateCheckOutput{
		Parse: make([]int64, len(input.Parse)),
		Match: make([]bool, len(input.Match)),
	}
	for index, value := range input.Parse {
		output.Parse[index] = ocxcli.ParsePIDFile(value)
	}
	for index, value := range input.Match {
		output.Match[index] = ocxcli.IsOcxStartCommandLine(value)
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return fmt.Errorf("processstatecheck: encode output: %w", err)
	}
	fmt.Println(string(encoded))
	return nil
}
