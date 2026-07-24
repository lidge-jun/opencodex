package cursor

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// KVStore is a concurrency-safe byte store. Values are cloned at both boundaries.
type KVStore struct {
	mu     sync.RWMutex
	values map[string][]byte
}

func NewKVStore(seed map[string][]byte) *KVStore {
	s := &KVStore{values: make(map[string][]byte, len(seed))}
	for key, value := range seed {
		s.values[key] = cloneBytes(value)
	}
	return s
}

func (s *KVStore) Get(key string) ([]byte, bool) {
	s.mu.RLock()
	value, ok := s.values[key]
	s.mu.RUnlock()
	if !ok {
		return nil, false
	}
	return cloneBytes(value), true
}

func (s *KVStore) Set(key string, value []byte) {
	s.mu.Lock()
	s.values[key] = cloneBytes(value)
	s.mu.Unlock()
}

func (s *KVStore) Delete(key string) { s.mu.Lock(); delete(s.values, key); s.mu.Unlock() }

// StoreBlob stores data under its SHA-256 digest and returns the raw digest.
func (s *KVStore) StoreBlob(data []byte) []byte {
	digest := sha256.Sum256(data)
	s.Set(hex.EncodeToString(digest[:]), data)
	return cloneBytes(digest[:])
}

func (s *KVStore) GetBlob(id []byte) ([]byte, bool) { return s.Get(hex.EncodeToString(id)) }

func cloneBytes(value []byte) []byte { return append([]byte(nil), value...) }
