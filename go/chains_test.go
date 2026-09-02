package arcusspot

import "testing"

func TestRobinhoodMainnetIncludesBebopRouter(t *testing.T) {
	want := "0xBeb0009ACa35087ce7cCF11637E24dd1Aad3bf2A"
	if got := RobinhoodMainnetDeployments.BebopRouter.Hex(); got != want {
		t.Fatalf("bebop router: got %s, want %s", got, want)
	}
	found := false
	for _, address := range GetSettlementSourceAddresses(RobinhoodMainnetChainID) {
		if address == RobinhoodMainnetDeployments.BebopRouter {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("Bebop router missing from settlement source addresses")
	}
}
