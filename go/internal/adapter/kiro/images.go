package kiro

import (
	"encoding/json"
	"strings"
)

type Image struct {
	Format string      `json:"format"`
	Source ImageSource `json:"source"`
}

type ImageSource struct {
	Bytes string `json:"bytes"`
}

func ParseDataURLImage(imageURL string) (Image, bool) {
	if !strings.HasPrefix(imageURL, "data:") {
		return Image{}, false
	}
	comma := strings.IndexByte(imageURL, ',')
	if comma < 0 || comma == len(imageURL)-1 {
		return Image{}, false
	}
	header, data := imageURL[5:comma], imageURL[comma+1:]
	mediaType := strings.Split(header, ";")[0]
	if mediaType == "" {
		mediaType = "image/jpeg"
	}
	format := mediaType
	if slash := strings.IndexByte(format, '/'); slash >= 0 {
		format = format[slash+1:]
	}
	format = strings.ToLower(format)
	if format == "jpg" {
		format = "jpeg"
	}
	if format == "" {
		format = "jpeg"
	}
	return Image{Format: format, Source: ImageSource{Bytes: data}}, true
}

func ExtractImages(content json.RawMessage) []Image {
	var value any
	if json.Unmarshal(content, &value) != nil {
		return nil
	}
	parts, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]Image, 0)
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		typeName, _ := part["type"].(string)
		if typeName != "image" && typeName != "input_image" && typeName != "image_url" {
			continue
		}
		url := firstString(part, "imageUrl", "image_url")
		if nested, ok := part["image_url"].(map[string]any); ok && url == "" {
			url = firstString(nested, "url")
		}
		if image, ok := ParseDataURLImage(url); ok {
			out = append(out, image)
		}
	}
	return out
}

type imageCarrier struct {
	Content string
	Images  []Image
}

func NormalizeImageCarriers(carriers []*imageCarrier) {
	for _, carrier := range carriers {
		if len(carrier.Images) > MaxImagesPerMessage {
			carrier.Images = append([]Image(nil), carrier.Images[len(carrier.Images)-MaxImagesPerMessage:]...)
			carrier.Content = appendImageNote(carrier.Content, "[image omitted: exceeded the 20-image per-message cap; oldest images in this message were dropped]")
		}
	}
	total := 0
	for _, carrier := range carriers {
		for _, image := range carrier.Images {
			total += len(image.Source.Bytes)
		}
	}
	for _, carrier := range carriers {
		for total > ImageBase64Budget && len(carrier.Images) > 0 {
			total -= len(carrier.Images[0].Source.Bytes)
			carrier.Images = carrier.Images[1:]
			carrier.Content = appendImageNote(carrier.Content, "[image omitted: image budget exceeded; oldest images were dropped]")
		}
	}
}

func appendImageNote(content, note string) string {
	if content == "" {
		return note
	}
	return content + "\n" + note
}
