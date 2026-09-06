package ocxcli

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex/go/internal/managementauth"
)

func TestDoctorDeepAttestedCollectors(t *testing.T) {
	secret := "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
	pid := int64(4242)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(managementauth.LocalManagementExpectedPIDHeader) != "4242" || r.Header.Get(managementauth.LocalManagementCapabilityHeader) == "" {
			t.Error("missing capability")
		}
		switch r.URL.Path {
		case doctorSystemMemoryPath:
			fmt.Fprint(w, "{\"PID\":4242,\"BunVersion\":\"1.2.3\",\"Platform\":\"linux\",\"RSS\":1048576}")
		case doctorCodexAccountsPath:
			fmt.Fprint(w, "{\"Accounts\":[{\"ID\":\"account-12345\",\"Health\":{\"Status\":\"cooldown\",\"Reason\":\"quota\",\"Until\":\"2026-01-01T00:00:00.000Z\"}}]}")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	host, portText, _ := net.SplitHostPort(u.Host)
	port, _ := strconv.Atoi(portText)
	reader := DoctorManagementReader{Runtime: RuntimeState{PID: pid, Port: port, Hostname: host, AttestationSecret: secret}, Client: server.Client()}
	if got := FetchDoctorServiceMemory(context.Background(), reader); got.Status != "ok" || got.Data.RSS != 1048576 {
		t.Fatalf("memory=%#v", got)
	}
	source, accounts := CollectDoctorLiveCodexAccounts(context.Background(), &reader)
	if source != DoctorOAuthManagementAPI || len(accounts) != 1 || accounts[0].Status != "cooldown" {
		t.Fatalf("accounts=%s %#v", source, accounts)
	}
}

func TestDoctorCatalogEqualMtimeIsStale(t *testing.T) {
	mtime := time.Unix(10, 0)
	equal := mtime
	got := CollectDoctorCatalogState(DoctorCatalogProbe{PIDs: []int{7}, Starts: map[int]*time.Time{7: &equal}, CatalogMtime: &mtime})
	if got.State != "stale" {
		t.Fatalf("state=%#v", got)
	}
}
