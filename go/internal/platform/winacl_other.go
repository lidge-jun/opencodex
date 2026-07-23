//go:build !windows

package platform

func HardenSecretPath(_ string, _ bool) error { return nil }
