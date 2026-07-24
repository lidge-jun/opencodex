package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type BucketKey string

const (
	BucketSessions          BucketKey = "sessions"
	BucketArchivedSessions  BucketKey = "archived_sessions"
	BucketLogsDB            BucketKey = "logs_db"
	BucketStateDB           BucketKey = "state_db"
	BucketAttachments       BucketKey = "attachments"
	BucketDeletionManifests BucketKey = "deletion_manifests"
	BucketOther             BucketKey = "other"
	largestLimit                      = 5
)

type LargestEntry struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}
type Bucket struct {
	Key       BucketKey      `json:"key"`
	Label     string         `json:"label"`
	Bytes     int64          `json:"bytes"`
	FileCount int            `json:"fileCount"`
	Oldest    *int64         `json:"oldest,omitempty"`
	Newest    *int64         `json:"newest,omitempty"`
	Largest   []LargestEntry `json:"largest,omitempty"`
	Rows      *int64         `json:"rows,omitempty"`
}
type Total struct {
	Bytes     int64 `json:"bytes"`
	FileCount int   `json:"fileCount"`
}
type Report struct {
	CodexHome   string   `json:"codexHome"`
	GeneratedAt int64    `json:"generatedAt"`
	Total       Total    `json:"total"`
	Buckets     []Bucket `json:"buckets"`
}

type fileEntry struct {
	path     string
	bytes    int64
	modified int64
}

var stateDBPattern = regexp.MustCompile(`^state_(\d+)\.sqlite(?:-(wal|shm))?$`)
var logsDBPattern = regexp.MustCompile(`^logs_(\d+)\.sqlite(?:-(wal|shm))?$`)

var bucketLabels = map[BucketKey]string{BucketSessions: "Active sessions", BucketArchivedSessions: "Archived sessions", BucketLogsDB: "Logs database", BucketStateDB: "State database", BucketAttachments: "Attachments", BucketDeletionManifests: "Deletion manifests", BucketOther: "Other"}
var directoryBuckets = map[string]BucketKey{"sessions": BucketSessions, "archived_sessions": BucketArchivedSessions, "attachments": BucketAttachments, "deletion_manifests": BucketDeletionManifests}

func Scan(codexHome string) (Report, error) {
	report := Report{CodexHome: codexHome, GeneratedAt: time.Now().UnixMilli()}
	files := map[BucketKey][]fileEntry{BucketSessions: {}, BucketArchivedSessions: {}, BucketLogsDB: {}, BucketStateDB: {}, BucketAttachments: {}, BucketDeletionManifests: {}, BucketOther: {}}
	entries, err := os.ReadDir(codexHome)
	if errors.Is(err, os.ErrNotExist) {
		return finishReport(report, files, nil), nil
	}
	if err != nil {
		return Report{}, fmt.Errorf("read Codex home: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
		full := filepath.Join(codexHome, entry.Name())
		info, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		if entry.IsDir() {
			bucket := directoryBuckets[entry.Name()]
			if bucket == "" {
				bucket = BucketOther
			}
			walkFiles(full, entry.Name(), bucket, files)
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		bucket := BucketOther
		if stateDBPattern.MatchString(entry.Name()) {
			bucket = BucketStateDB
		} else if logsDBPattern.MatchString(entry.Name()) {
			bucket = BucketLogsDB
		}
		files[bucket] = append(files[bucket], fileEntry{path: filepath.ToSlash(entry.Name()), bytes: info.Size(), modified: info.ModTime().UnixMilli()})
	}
	rows := map[BucketKey]*int64{}
	if name := newestVersionedDB(names, stateDBPattern); name != "" {
		rows[BucketStateDB] = countRowsReadonly(filepath.Join(codexHome, name), "threads")
	}
	if name := newestVersionedDB(names, logsDBPattern); name != "" {
		rows[BucketLogsDB] = countRowsReadonly(filepath.Join(codexHome, name), "logs")
	}
	return finishReport(report, files, rows), nil
}

func walkFiles(root, relative string, bucket BucketKey, files map[BucketKey][]fileEntry) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		full := filepath.Join(root, entry.Name())
		rel := filepath.Join(relative, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if entry.IsDir() {
			walkFiles(full, rel, bucket, files)
		} else if info.Mode().IsRegular() {
			files[bucket] = append(files[bucket], fileEntry{path: filepath.ToSlash(rel), bytes: info.Size(), modified: info.ModTime().UnixMilli()})
		}
	}
}

func finishReport(report Report, files map[BucketKey][]fileEntry, rows map[BucketKey]*int64) Report {
	order := []BucketKey{BucketSessions, BucketArchivedSessions, BucketLogsDB, BucketStateDB, BucketAttachments, BucketDeletionManifests, BucketOther}
	for _, key := range order {
		bucket := Bucket{Key: key, Label: bucketLabels[key], FileCount: len(files[key])}
		for _, file := range files[key] {
			bucket.Bytes += file.bytes
			if bucket.Oldest == nil || file.modified < *bucket.Oldest {
				v := file.modified
				bucket.Oldest = &v
			}
			if bucket.Newest == nil || file.modified > *bucket.Newest {
				v := file.modified
				bucket.Newest = &v
			}
		}
		largest := append([]fileEntry(nil), files[key]...)
		sort.Slice(largest, func(i, j int) bool { return largest[i].bytes > largest[j].bytes })
		for _, file := range largest[:min(len(largest), largestLimit)] {
			bucket.Largest = append(bucket.Largest, LargestEntry{Path: file.path, Bytes: file.bytes})
		}
		if rows != nil {
			bucket.Rows = rows[key]
		}
		report.Buckets = append(report.Buckets, bucket)
		report.Total.Bytes += bucket.Bytes
		report.Total.FileCount += bucket.FileCount
	}
	return report
}

func newestVersionedDB(names []string, pattern *regexp.Regexp) string {
	best := ""
	version := -1
	for _, name := range names {
		match := pattern.FindStringSubmatch(name)
		if match == nil || match[2] != "" {
			continue
		}
		current, err := strconv.Atoi(match[1])
		if err == nil && current > version {
			best = name
			version = current
		}
	}
	return best
}

func countRowsReadonly(path, table string) *int64 {
	allowed := map[string]bool{"threads": true, "logs": true}
	if !allowed[table] {
		return nil
	}
	u := readonlySQLiteURL(path)
	db, err := sql.Open("sqlite", u)
	if err != nil {
		return nil
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	var count int64
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM "`+strings.ReplaceAll(table, `"`, `""`)+`"`).Scan(&count); err != nil {
		return nil
	}
	return &count
}

func readonlySQLiteURL(path string) string {
	normalized := strings.ReplaceAll(path, `\`, "/")
	if len(normalized) >= 2 && normalized[1] == ':' {
		normalized = "/" + normalized
	}
	u := url.URL{Scheme: "file", Path: normalized}
	query := u.Query()
	query.Set("mode", "ro")
	query.Set("immutable", "1")
	query.Set("_pragma", "query_only(1)")
	query.Add("_pragma", "busy_timeout(50)")
	u.RawQuery = query.Encode()
	return u.String()
}
