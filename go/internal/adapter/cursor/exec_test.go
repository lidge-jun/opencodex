package cursor

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestKVStoreClonesValuesAndBlobKeys(t *testing.T) {
	seed := []byte("seed")
	store := NewKVStore(map[string][]byte{"key": seed})
	seed[0] = 'x'
	got, ok := store.Get("key")
	if !ok || string(got) != "seed" {
		t.Fatalf("seed clone = %q, %v", got, ok)
	}
	got[0] = 'x'
	again, _ := store.Get("key")
	if string(again) != "seed" {
		t.Fatalf("get returned aliased bytes: %q", again)
	}
	id := store.StoreBlob([]byte("payload"))
	blob, ok := store.GetBlob(id)
	if !ok || string(blob) != "payload" {
		t.Fatalf("blob = %q, %v", blob, ok)
	}
}

func TestExecPolicyFailsClosedAndRequestCanOnlyNarrow(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	for _, mode := range []NativeExecMode{"", ExecOff, ExecCodexSandbox} {
		policy := ExecPolicy{Provider: ProviderPolicy{Mode: mode, FilesystemRoots: []string{root}}}
		if _, err := policy.CheckPath("read", path); !errors.Is(err, ErrPolicyDenied) {
			t.Fatalf("mode %q error = %v", mode, err)
		}
	}
	allowed := ExecPolicy{Provider: ProviderPolicy{Mode: ExecOn, FilesystemRoots: []string{root}}}
	if _, err := allowed.CheckPath("read", path); err != nil {
		t.Fatalf("explicit on denied: %v", err)
	}
	outside := filepath.Join(filepath.Dir(root), "outside.txt")
	if _, err := allowed.CheckPath("read", outside); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("outside root error = %v", err)
	}
	narrowed := allowed
	narrowed.Request.DenyFilesystem = true
	if _, err := narrowed.CheckPath("read", path); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("request deny error = %v", err)
	}
}

func TestFilesystemReadBoundsAndMutationPolicy(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "large.txt")
	content := bytes.Repeat([]byte("a"), 64)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	policy := ExecPolicy{Provider: ProviderPolicy{Mode: ExecOn, FilesystemRoots: []string{root}, MaxReadBytes: 16, MaxWriteBytes: 8}}
	fs := FilesystemExecutor{Policy: policy, Blobs: NewKVStore(nil)}
	result, err := fs.Read(ReadRequest{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Content) != 16 || !result.Truncated || result.Size != 64 {
		t.Fatalf("bounded read = len %d truncated %v size %d", len(result.Content), result.Truncated, result.Size)
	}
	if _, err := fs.Write(WriteRequest{Path: filepath.Join(root, "too-large"), Content: []byte("123456789")}); err == nil {
		t.Fatal("oversized write was allowed")
	}
	fs.Policy.Request.DenyMutations = true
	if _, err := fs.Write(WriteRequest{Path: filepath.Join(root, "denied"), Content: []byte("ok")}); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("mutation policy error = %v", err)
	}
}

func TestFilesystemRootCheckResolvesSymlink(t *testing.T) {
	if os.Getenv("GOOS") == "windows" {
		t.Skip("symlink permissions vary on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	policy := ExecPolicy{Provider: ProviderPolicy{Mode: ExecOn, FilesystemRoots: []string{root}}}
	if _, err := policy.CheckPath("write", filepath.Join(link, "file")); !errors.Is(err, ErrPolicyDenied) {
		t.Fatalf("symlink escape error = %v", err)
	}
}
