package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func packageVersionAt(dir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return "", err
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil || manifest.Version == "" {
		if err == nil {
			err = os.ErrInvalid
		}
		return "", err
	}
	return manifest.Version, nil
}
