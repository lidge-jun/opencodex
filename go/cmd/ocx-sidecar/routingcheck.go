package main

import (
	"encoding/json"
	"fmt"
	"github.com/lidge-jun/opencodex/go/internal/routing/hotpath"
	"os"
)

func runRoutingCheck() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("routingcheck requires one JSON array argument")
	}
	var inputs []hotpath.Input
	if err := json.Unmarshal([]byte(os.Args[2]), &inputs); err != nil {
		return fmt.Errorf("routingcheck: decode: %w", err)
	}
	out := make([]hotpath.Decision, len(inputs))
	for i, input := range inputs {
		out[i] = hotpath.Decide(input)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("routingcheck: encode: %w", err)
	}
	_, err = fmt.Println(string(raw))
	return err
}
