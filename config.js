// CloudKit JS configuration (CloudKit Console → iCloud.com.fbmore.TickyTacky → Tokens & Keys,
// sign-in callback: post message, allowed origin fbmore.github.io).
// Production matches TestFlight / App Store builds. Builds run from Xcode use Development:
// add ?ckenv=dev to a URL to point the web player at Development for testing with them.
const DEV = { apiToken: "6fd0a02e64362a9bf7a2f37d284a72ee0f852c708e70896ec42cb5cfa3d721f5", environment: "development" };
const PROD = { apiToken: "c172fbe5324b81bdb90a94527ab657359e3b45e2e5b82f2815ad77b7d98d0c71", environment: "production" };
const useDev = new URLSearchParams(location.search).get("ckenv") === "dev";

export const CONFIG = {
  containerIdentifier: "iCloud.com.fbmore.TickyTacky",
  ...(useDev ? DEV : PROD),
};
