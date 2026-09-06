package hotpath

import "testing"

func num(v float64) *float64 { return &v }
func TestDecideQuotaCooldownAndFailover(t *testing.T) {
	now := int64(1000)
	d := Decide(Input{NowMS: now, ActiveAccountID: "a", Accounts: []Account{{ID: "a", Usable: true, UsagePercent: num(90)}, {ID: "b", Usable: true, UsagePercent: num(10)}, {ID: "c", Usable: true, UsagePercent: num(1), CooldownUntilMS: now + 5}}})
	if d.AccountID != "b" {
		t.Fatal(d)
	}
	d = Decide(Input{NowMS: now, Keys: []Key{{ID: "a"}, {ID: "b"}}, FailedKeyID: "a", Status: 429, RetryAfter: "7"})
	if d.KeyID != "b" || d.CooldownUntilMS != 8000 {
		t.Fatal(d)
	}
}

func TestRetryAfterRejectsNonTypeScriptNumericForms(t *testing.T) {
	for _, value := range []string{"1e3", "+5", "0x10"} {
		if got := retryMS(value, 1_000); got != DefaultKeyCooldownMS {
			t.Fatalf("%q = %d, want default", value, got)
		}
	}
}
