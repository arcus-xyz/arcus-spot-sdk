import { expect, test } from "bun:test";
import {
  getSettlementSourceAddresses,
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_MAINNET_DEPLOYMENTS,
} from "../src";

test("Robinhood mainnet includes the Bebop settlement router", () => {
  expect(ROBINHOOD_MAINNET_DEPLOYMENTS.bebopRouter).toBe(
    "0xBeb0009ACa35087ce7cCF11637E24dd1Aad3bf2A",
  );
  expect(getSettlementSourceAddresses(ROBINHOOD_MAINNET_CHAIN_ID)).toContain(
    ROBINHOOD_MAINNET_DEPLOYMENTS.bebopRouter.toLowerCase(),
  );
});
