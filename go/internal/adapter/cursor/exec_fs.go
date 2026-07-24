package cursor

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

const (
	defaultMaxFileBytes   = int64(1_000_000)
	defaultMaxGrepFiles   = 500
	defaultMaxGrepResults = 200
)

type ReadRequest struct {
	Path     string
	MaxBytes int64
}
type ReadResult struct {
	Path      string
	Content   []byte
	Size      int64
	Lines     int
	Truncated bool
	BlobID    []byte
}
type WriteRequest struct {
	Path          string
	Content       []byte
	BlobID        []byte
	ReturnContent bool
}
type WriteResult struct {
	Path    string
	Size    int64
	Lines   int
	Content []byte
}
type DeleteRequest struct {
	Path      string
	Recursive bool
}
type DeleteResult struct {
	Path         string
	Size         int64
	WasDirectory bool
}
type ListRequest struct {
	Path  string
	Limit int
}
type ListEntry struct {
	Name      string
	Path      string
	Directory bool
	Size      int64
}
type ListResult struct {
	Path      string
	Entries   []ListEntry
	Truncated bool
}
type GrepRequest struct {
	Path, Pattern, Glob, OutputMode string
	CaseInsensitive                 bool
	Limit                           int
}
type GrepMatch struct {
	Path    string
	Line    int
	Content string
}
type GrepResult struct {
	Matches    []GrepMatch
	FileCounts map[string]int
	Files      []string
	Truncated  bool
}

type FilesystemExecutor struct {
	Policy ExecPolicy
	Blobs  *KVStore
}

func (e *FilesystemExecutor) Read(req ReadRequest) (ReadResult, error) {
	path, err := e.Policy.CheckPath("read", req.Path)
	if err != nil {
		return ReadResult{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ReadResult{}, err
	}
	if !info.Mode().IsRegular() {
		return ReadResult{}, fmt.Errorf("read %s: not a regular file", path)
	}
	limit := req.MaxBytes
	if limit <= 0 || limit > maxOr(e.Policy.Provider.MaxReadBytes, defaultMaxFileBytes) {
		limit = maxOr(e.Policy.Provider.MaxReadBytes, defaultMaxFileBytes)
	}
	f, err := os.Open(path)
	if err != nil {
		return ReadResult{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return ReadResult{}, err
	}
	truncated := int64(len(data)) > limit
	if truncated {
		data = data[:limit]
	}
	result := ReadResult{Path: path, Content: data, Size: info.Size(), Lines: lineCount(data), Truncated: truncated}
	if truncated && e.Blobs != nil {
		result.BlobID = e.Blobs.StoreBlob(data)
	}
	return result, nil
}

func (e *FilesystemExecutor) Write(req WriteRequest) (WriteResult, error) {
	path, err := e.Policy.CheckPath("write", req.Path)
	if err != nil {
		return WriteResult{}, err
	}
	content := cloneBytes(req.Content)
	if len(req.BlobID) > 0 {
		if e.Blobs == nil {
			return WriteResult{}, errors.New("blob store is not configured")
		}
		var ok bool
		content, ok = e.Blobs.GetBlob(req.BlobID)
		if !ok {
			return WriteResult{}, errors.New("write blob not found")
		}
	}
	if int64(len(content)) > maxOr(e.Policy.Provider.MaxWriteBytes, defaultMaxFileBytes) {
		return WriteResult{}, fmt.Errorf("write exceeds %d-byte limit", maxOr(e.Policy.Provider.MaxWriteBytes, defaultMaxFileBytes))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return WriteResult{}, err
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return WriteResult{}, err
	}
	result := WriteResult{Path: path, Size: int64(len(content)), Lines: lineCount(content)}
	if req.ReturnContent {
		result.Content = cloneBytes(content)
	}
	return result, nil
}

func (e *FilesystemExecutor) Delete(req DeleteRequest) (DeleteResult, error) {
	path, err := e.Policy.CheckPath("delete", req.Path)
	if err != nil {
		return DeleteResult{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return DeleteResult{}, err
	}
	result := DeleteResult{Path: path, Size: info.Size(), WasDirectory: info.IsDir()}
	if info.IsDir() && !req.Recursive {
		err = os.Remove(path)
	} else {
		err = os.RemoveAll(path)
	}
	return result, err
}

func (e *FilesystemExecutor) List(req ListRequest) (ListResult, error) {
	path, err := e.Policy.CheckPath("list", req.Path)
	if err != nil {
		return ListResult{}, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return ListResult{}, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	limit := req.Limit
	if limit <= 0 {
		limit = 200
	}
	result := ListResult{Path: path}
	for i, entry := range entries {
		if i >= limit {
			result.Truncated = true
			break
		}
		info, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		result.Entries = append(result.Entries, ListEntry{Name: entry.Name(), Path: filepath.Join(path, entry.Name()), Directory: entry.IsDir(), Size: info.Size()})
	}
	return result, nil
}

func (e *FilesystemExecutor) Grep(req GrepRequest) (GrepResult, error) {
	root, err := e.Policy.CheckPath("grep", req.Path)
	if err != nil {
		return GrepResult{}, err
	}
	pattern := req.Pattern
	if req.CaseInsensitive {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return GrepResult{}, fmt.Errorf("invalid grep pattern: %w", err)
	}
	limit := req.Limit
	policyLimit := e.Policy.Provider.MaxGrepResults
	if policyLimit <= 0 {
		policyLimit = defaultMaxGrepResults
	}
	if limit <= 0 || limit > policyLimit {
		limit = policyLimit
	}
	result := GrepResult{FileCounts: map[string]int{}}
	files := 0
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && (entry.Name() == ".git" || entry.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if files >= defaultMaxGrepFiles || len(result.Matches) >= limit {
			result.Truncated = true
			return fs.SkipAll
		}
		if req.Glob != "" {
			matched, globErr := filepath.Match(req.Glob, entry.Name())
			if globErr != nil {
				return globErr
			}
			if !matched {
				return nil
			}
		}
		info, statErr := entry.Info()
		if statErr != nil || info.Size() > defaultMaxFileBytes {
			return nil
		}
		files++
		return scanMatches(path, re, limit, &result)
	})
	if err != nil {
		return GrepResult{}, err
	}
	for path := range result.FileCounts {
		result.Files = append(result.Files, path)
	}
	sort.Strings(result.Files)
	return result, nil
}

func scanMatches(path string, re *regexp.Regexp, limit int, result *GrepResult) error {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), int(defaultMaxFileBytes))
	line := 0
	for scanner.Scan() {
		line++
		if !re.Match(scanner.Bytes()) {
			continue
		}
		result.FileCounts[path]++
		if len(result.Matches) < limit {
			result.Matches = append(result.Matches, GrepMatch{Path: path, Line: line, Content: scanner.Text()})
		} else {
			result.Truncated = true
			break
		}
	}
	return scanner.Err()
}

func lineCount(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	return bytes.Count(data, []byte{'\n'}) + 1
}
