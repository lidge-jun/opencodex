package platform

import (
	"fmt"
	"os"
	"strings"
)

const MaxServiceTokenBytes = 64 << 10

// LoadServiceToken returns an existing environment token, or securely loads tokenFile.
func LoadServiceToken(environmentToken, tokenFile string) (string, error) {
	if token := strings.TrimSpace(environmentToken); token != "" {
		return token, nil
	}
	if strings.TrimSpace(tokenFile) == "" {
		return "", nil
	}
	info, err := os.Stat(tokenFile)
	if err != nil {
		return "", fmt.Errorf("stat service token: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > MaxServiceTokenBytes {
		return "", fmt.Errorf("service token must be a regular file no larger than %d bytes", MaxServiceTokenBytes)
	}
	data, err := os.ReadFile(tokenFile)
	if err != nil {
		return "", fmt.Errorf("read service token: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}
