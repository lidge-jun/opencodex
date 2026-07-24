package vision

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

const (
	DefaultCacheSize = 256
	DefaultCacheTTL  = 24 * time.Hour
)

type cacheEntry struct {
	key       string
	value     string
	expiresAt time.Time
}

// DescriptionCache is a concurrency-safe, bounded LRU cache shared across turns.
// Entries are addressed by the SHA-256 hash of the decoded image bytes.
type DescriptionCache struct {
	mu         sync.Mutex
	maxEntries int
	ttl        time.Duration
	now        func() time.Time
	entries    map[string]*list.Element
	lru        *list.List
}

func NewDescriptionCache(maxEntries int, ttl time.Duration) *DescriptionCache {
	if maxEntries <= 0 {
		maxEntries = DefaultCacheSize
	}
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	return &DescriptionCache{
		maxEntries: maxEntries,
		ttl:        ttl,
		now:        time.Now,
		entries:    make(map[string]*list.Element, maxEntries),
		lru:        list.New(),
	}
}

// HashImage returns the stable cache identity for decoded image bytes.
func HashImage(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (c *DescriptionCache) Get(hash string) (string, bool) {
	if c == nil || hash == "" {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	element, ok := c.entries[hash]
	if !ok {
		return "", false
	}
	entry := element.Value.(*cacheEntry)
	if !c.now().Before(entry.expiresAt) {
		c.remove(element)
		return "", false
	}
	c.lru.MoveToFront(element)
	return entry.value, true
}

func (c *DescriptionCache) Set(hash, description string) {
	if c == nil || hash == "" || description == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if element, ok := c.entries[hash]; ok {
		entry := element.Value.(*cacheEntry)
		entry.value = description
		entry.expiresAt = c.now().Add(c.ttl)
		c.lru.MoveToFront(element)
		return
	}
	entry := &cacheEntry{key: hash, value: description, expiresAt: c.now().Add(c.ttl)}
	c.entries[hash] = c.lru.PushFront(entry)
	for c.lru.Len() > c.maxEntries {
		c.remove(c.lru.Back())
	}
}

func (c *DescriptionCache) Clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]*list.Element, c.maxEntries)
	c.lru.Init()
}

func (c *DescriptionCache) remove(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(*cacheEntry)
	delete(c.entries, entry.key)
	c.lru.Remove(element)
}
