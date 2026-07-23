package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func accountStore() (*oauth.CredentialStore, error) {
	dir, err := configDir()
	if err != nil {
		return nil, err
	}
	return oauth.NewCredentialStore(filepath.Join(dir, "auth.json")), nil
}

func runAccount(ctx context.Context, args []string, streams IO) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: ocx account <list|switch|add|remove|refresh>")
	}
	store, err := accountStore()
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		return accountList(store, args[1:], streams)
	case "switch", "use":
		if len(args) != 3 {
			return fmt.Errorf("usage: ocx account switch <provider> <account-id>")
		}
		changed, err := store.SetActiveAccount(ctx, args[1], args[2])
		if err != nil {
			return err
		}
		if !changed {
			return fmt.Errorf("account %q was not found for %s", args[2], args[1])
		}
		fmt.Fprintf(streams.Out, "Active %s account: %s\n", args[1], args[2])
		return nil
	case "add":
		return accountAdd(ctx, store, args[1:], streams)
	case "remove":
		if len(args) != 3 {
			return fmt.Errorf("usage: ocx account remove <provider> <account-id>")
		}
		removed, err := store.RemoveAccount(ctx, args[1], args[2])
		if err != nil {
			return err
		}
		if !removed {
			return fmt.Errorf("account %q was not found for %s", args[2], args[1])
		}
		return nil
	case "refresh":
		if len(args) != 2 && len(args) != 3 {
			return fmt.Errorf("usage: ocx account refresh <provider> [account-id]")
		}
		return accountRefresh(ctx, store, args[1:], streams)
	default:
		return fmt.Errorf("unknown account subcommand %q", args[0])
	}
}

func accountList(store *oauth.CredentialStore, args []string, streams IO) error {
	if len(args) > 1 {
		return fmt.Errorf("usage: ocx account list [provider]")
	}
	auth, err := store.Load()
	if err != nil {
		return err
	}
	providers := make([]string, 0, len(auth))
	for provider := range auth {
		if len(args) == 0 || provider == args[0] {
			providers = append(providers, provider)
		}
	}
	sort.Strings(providers)
	for _, provider := range providers {
		set := auth[provider]
		for _, account := range set.Accounts {
			marker := " "
			if account.ID == set.ActiveAccountID {
				marker = "*"
			}
			identity := account.Alias
			if identity == "" {
				identity = account.Credential.Email
			}
			if identity == "" {
				identity = "-"
			}
			fmt.Fprintf(streams.Out, "%s %-18s %-12s %s\n", marker, provider, account.ID, identity)
		}
	}
	return nil
}

func accountAdd(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	flags := flag.NewFlagSet("account add", flag.ContinueOnError)
	flags.SetOutput(streams.Err)
	id := flags.String("id", "", "optional account label for output")
	access := flags.String("access-token", "", "access token")
	refresh := flags.String("refresh-token", "", "refresh token")
	expires := flags.Int64("expires", time.Now().Add(time.Hour).UnixMilli(), "expiry in epoch milliseconds")
	jsonStdin := flags.Bool("json-stdin", false, "read credential JSON from stdin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("usage: ocx account add <provider> --id ID [--json-stdin]")
	}
	provider := flags.Arg(0)
	credential := oauth.OAuthCredentials{Access: *access, Refresh: *refresh, Expires: *expires, Source: oauth.SourceManual}
	if *jsonStdin {
		decoder := json.NewDecoder(io.LimitReader(streams.In, 1<<20))
		if err := decoder.Decode(&credential); err != nil {
			return fmt.Errorf("decode credential JSON: %w", err)
		}
	}
	if credential.Access == "" {
		credential.Access = strings.TrimSpace(os.Getenv("OCX_ACCOUNT_ACCESS_TOKEN"))
	}
	if credential.Access == "" {
		return fmt.Errorf("access token is required; prefer --json-stdin or OCX_ACCOUNT_ACCESS_TOKEN")
	}
	if strings.ContainsAny(credential.Access, "\r\n") {
		return fmt.Errorf("access token must not contain line breaks")
	}
	if err := store.SaveCredential(ctx, provider, credential); err != nil {
		return err
	}
	label := *id
	if label == "" {
		label = "credential"
	}
	fmt.Fprintf(streams.Out, "Added %s account %s.\n", provider, label)
	return nil
}

func accountRefresh(ctx context.Context, store *oauth.CredentialStore, args []string, streams IO) error {
	set, ok, err := store.GetAccountSet(args[0])
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no accounts for %s", args[0])
	}
	accountID := set.ActiveAccountID
	if len(args) == 2 {
		accountID = args[1]
	}
	credential, ok, err := store.GetAccountCredential(args[0], accountID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("account %q was not found", accountID)
	}
	flowName := args[0]
	if flowName == "openai" {
		flowName = "chatgpt"
	}
	flow, flowErr := oauth.ProviderFlow(flowName, nil)
	if flowErr == nil && credential.Refresh != "" {
		result, refreshErr := store.RefreshAccount(ctx, args[0], accountID, flow.Refresh)
		if refreshErr != nil {
			return refreshErr
		}
		fmt.Fprintf(streams.Out, "Refreshed account %s; valid until %s.\n", accountID, time.UnixMilli(result.Credential.Expires).Format(time.RFC3339))
		return nil
	}
	if credential.Expired(time.Now(), time.Minute) {
		return fmt.Errorf("account %s requires provider reauthentication: %w", accountID, flowErr)
	}
	fmt.Fprintf(streams.Out, "Account %s is valid until %s.\n", accountID, time.UnixMilli(credential.Expires).Format(time.RFC3339))
	return nil
}
