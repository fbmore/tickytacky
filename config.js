// CloudKit JS configuration (CloudKit Console → iCloud.com.fbmore.Wubee → Tokens & Keys,
// sign-in callback: post message, allowed origins wubee.app, fbmore.github.io).
// Production matches TestFlight / App Store builds. Builds run from Xcode use Development:
// add ?ckenv=dev to a URL to point the web player at Development for testing with them.
const DEV = { apiToken: "37729100e0ccd75f4925a6535fa9553358d5132277668ecb1a247f5ea1c788de", environment: "development" };
const PROD = { apiToken: "216c070bfdd1dfe328428b26ea8fdcda0428543e310d5b3c8058be10e1918f78", environment: "production" };
const useDev = new URLSearchParams(location.search).get("ckenv") === "dev";

export const CONFIG = {
  containerIdentifier: "iCloud.com.fbmore.Wubee",
  ...(useDev ? DEV : PROD),
};
