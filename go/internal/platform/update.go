package platform

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const MaxUpdateBytes int64 = 256 << 20

// DownloadAndReplace downloads an HTTPS binary, verifies SHA-256, then atomically replaces destination.
func DownloadAndReplace(ctx context.Context, sourceURL, expectedSHA256, destination string) error {
	parsed, err := url.ParseRequestURI(sourceURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("update URL must be HTTPS")
	}
	expected, err := hex.DecodeString(strings.TrimSpace(expectedSHA256))
	if err != nil || len(expected) != sha256.Size {
		return fmt.Errorf("expected SHA-256 must be 64 hexadecimal characters")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("download update returned %s", response.Status)
	}
	if response.ContentLength > MaxUpdateBytes {
		return fmt.Errorf("update exceeds %d bytes", MaxUpdateBytes)
	}
	return replaceFromReader(io.LimitReader(response.Body, MaxUpdateBytes+1), expected, destination)
}

func replaceFromReader(reader io.Reader, expected []byte, destination string) error {
	dir := filepath.Dir(destination)
	temp, err := os.CreateTemp(dir, ".ocx-update-*")
	if err != nil {
		return fmt.Errorf("create update temporary file: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hash), reader)
	if copyErr != nil {
		temp.Close()
		return fmt.Errorf("write update: %w", copyErr)
	}
	if written > MaxUpdateBytes {
		temp.Close()
		return fmt.Errorf("update exceeds %d bytes", MaxUpdateBytes)
	}
	if !equalBytes(hash.Sum(nil), expected) {
		temp.Close()
		return fmt.Errorf("update SHA-256 mismatch")
	}
	mode := os.FileMode(0o755)
	if info, statErr := os.Stat(destination); statErr == nil {
		mode = info.Mode().Perm()
	}
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := atomicReplace(tempPath, destination); err != nil {
		return fmt.Errorf("atomically replace executable: %w", err)
	}
	return nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for index := range left {
		different |= left[index] ^ right[index]
	}
	return different == 0
}
