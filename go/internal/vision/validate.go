package vision

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/url"
	"strings"

	_ "golang.org/x/image/webp"
)

const (
	DefaultMaxImageBytes  = 20 * 1024 * 1024
	DefaultMaxImageEdge   = 8000
	DefaultMaxImagePixels = 100_000_000
)

var allowedImageMIME = map[string]bool{
	"image/gif": true, "image/jpeg": true, "image/png": true, "image/webp": true,
}

type ValidationOptions struct {
	MaxBytes  int
	MaxEdge   int
	MaxPixels int64
}

type Image struct {
	URL       string
	MediaType string
	Data      []byte
	Width     int
	Height    int
	Detail    string
}

func (o ValidationOptions) defaults() ValidationOptions {
	if o.MaxBytes <= 0 {
		o.MaxBytes = DefaultMaxImageBytes
	}
	if o.MaxEdge <= 0 {
		o.MaxEdge = DefaultMaxImageEdge
	}
	if o.MaxPixels <= 0 {
		o.MaxPixels = DefaultMaxImagePixels
	}
	return o
}

// ParseImage validates a base64 data URL or an HTTPS image URL. Remote URLs are
// never fetched by the proxy, avoiding an SSRF boundary; the provider fetches them.
func ParseImage(value string, options ValidationOptions) (Image, error) {
	options = options.defaults()
	if strings.HasPrefix(value, "data:") {
		return parseDataURL(value, options)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return Image{}, fmt.Errorf("unsupported image URL: expected a base64 data URL or HTTPS URL")
	}
	return Image{URL: value}, nil
}

func parseDataURL(value string, options ValidationOptions) (Image, error) {
	header, payload, ok := strings.Cut(strings.TrimPrefix(value, "data:"), ",")
	if !ok {
		return Image{}, fmt.Errorf("malformed image data URL: missing comma")
	}
	mediaType, encoding, ok := strings.Cut(header, ";")
	mediaType = normalizeMIME(mediaType)
	if !ok || !strings.EqualFold(encoding, "base64") {
		return Image{}, fmt.Errorf("malformed image data URL: base64 encoding is required")
	}
	if !allowedImageMIME[mediaType] {
		return Image{}, fmt.Errorf("unsupported image MIME type %q", mediaType)
	}
	if payload == "" {
		return Image{}, fmt.Errorf("malformed image data URL: empty payload")
	}
	if base64.StdEncoding.DecodedLen(len(payload)) > options.MaxBytes {
		return Image{}, fmt.Errorf("image exceeds decoded size limit of %d bytes", options.MaxBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return Image{}, fmt.Errorf("malformed image base64 payload: %w", err)
	}
	if len(decoded) > options.MaxBytes {
		return Image{}, fmt.Errorf("image exceeds decoded size limit of %d bytes", options.MaxBytes)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(decoded))
	if err != nil {
		return Image{}, fmt.Errorf("decode image dimensions: %w", err)
	}
	detectedMIME := formatMIME(format)
	if detectedMIME == "" || detectedMIME != mediaType {
		return Image{}, fmt.Errorf("image MIME type %q does not match decoded %q image", mediaType, format)
	}
	if config.Width <= 0 || config.Height <= 0 || config.Width > options.MaxEdge || config.Height > options.MaxEdge {
		return Image{}, fmt.Errorf("image dimensions %dx%d exceed the %dpx edge limit", config.Width, config.Height, options.MaxEdge)
	}
	if int64(config.Width) > options.MaxPixels/int64(config.Height) {
		return Image{}, fmt.Errorf("image dimensions %dx%d exceed the %d pixel limit", config.Width, config.Height, options.MaxPixels)
	}
	return Image{URL: value, MediaType: mediaType, Data: decoded, Width: config.Width, Height: config.Height}, nil
}

func normalizeMIME(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "image/jpg" {
		return "image/jpeg"
	}
	return value
}

func formatMIME(format string) string {
	switch strings.ToLower(format) {
	case "gif", "jpeg", "png", "webp":
		if format == "jpg" || format == "jpeg" {
			return "image/jpeg"
		}
		return "image/" + strings.ToLower(format)
	default:
		return ""
	}
}

func imageIdentity(image Image) string {
	if len(image.Data) > 0 {
		return HashImage(image.Data)
	}
	return HashImage([]byte(image.URL))
}

func imageDataURL(image Image) string {
	if strings.HasPrefix(image.URL, "data:") || len(image.Data) == 0 {
		return image.URL
	}
	return "data:" + image.MediaType + ";base64," + base64.StdEncoding.EncodeToString(image.Data)
}
