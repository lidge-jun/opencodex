package server

import (
	"net"
	"testing"
)

func TestFindAvailablePortFallsBack(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	busy := listener.Addr().(*net.TCPAddr).Port
	port, err := FindAvailablePort("127.0.0.1", busy, true)
	if err != nil {
		t.Fatal(err)
	}
	if port == 0 || port == busy {
		t.Fatalf("fallback port = %d", port)
	}
}
