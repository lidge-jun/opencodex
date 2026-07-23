package server

import (
	"fmt"
	"net"
	"strconv"
)

// IsPortAvailable reports whether an address can currently be bound.
func IsPortAvailable(host string, port int) bool {
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

// FindAvailablePort returns preferred when possible, otherwise an OS-selected port.
func FindAvailablePort(host string, preferred int, allowFallback bool) (int, error) {
	if preferred > 0 && IsPortAvailable(host, preferred) {
		return preferred, nil
	}
	if !allowFallback {
		return 0, fmt.Errorf("port %d on %s is unavailable", preferred, host)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		return 0, err
	}
	return port, nil
}
