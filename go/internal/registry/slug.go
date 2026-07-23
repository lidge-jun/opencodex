package registry

import "strings"

const SlugAliasSeparator = "-"

// EncodeRoutedModelID converts inner provider model namespaces to Codex-safe aliases.
func EncodeRoutedModelID(id string) string { return strings.ReplaceAll(id, "/", SlugAliasSeparator) }

// RoutedSlug creates a selector containing exactly one provider separator.
func RoutedSlug(provider, id string) string { return provider + "/" + EncodeRoutedModelID(id) }

// DecodeRoutedModelID decodes only an exact, unique alias from known native IDs.
func DecodeRoutedModelID(requested string, knownIDs []string) string {
	match := ""
	for _, id := range knownIDs {
		if id == requested {
			return requested
		}
		if strings.Contains(id, "/") && EncodeRoutedModelID(id) == requested {
			if match != "" && match != id {
				return requested
			}
			match = id
		}
	}
	if match != "" {
		return match
	}
	return requested
}

func SlugEquals(stored, provider, id string) bool {
	return stored == provider+"/"+id || stored == RoutedSlug(provider, id)
}

func SlugsEquivalent(a, b string) bool {
	if a == b {
		return true
	}
	pa, pb := strings.IndexByte(a, '/'), strings.IndexByte(b, '/')
	return pa > 0 && pb > 0 && a[:pa] == b[:pb] && EncodeRoutedModelID(a[pa+1:]) == EncodeRoutedModelID(b[pb+1:])
}
