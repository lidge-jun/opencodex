package server

import (
	"io"
	"strings"
	"testing"
)

func TestRepairResponsesItemIDs(t *testing.T) {
	input := "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\"}}\n\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"bad\",\"delta\":\"x\"}\n\n"
	output, err := io.ReadAll(RepairResponsesItemIDs(strings.NewReader(input)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), `"item_id":"bad"`) || !strings.Contains(string(output), `"id":"msg_ocx_`) {
		t.Fatalf("output = %s", output)
	}
}
