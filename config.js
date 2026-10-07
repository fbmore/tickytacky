// CloudKit JS configuration (CloudKit Console → iCloud.com.fbmore.TicTacCube → Tokens & Keys,
// sign-in callback: post message, allowed origin fbmore.github.io).
// Production matches TestFlight / App Store builds. Builds run from Xcode use Development:
// add ?ckenv=dev to a URL to point the web player at Development for testing with them.
const DEV = { apiToken: "8432b114045c4bdd80508495488b296330a3cd94799b5c7f9fbb58a0acfca9bd", environment: "development" };
const PROD = { apiToken: "982c0e004d695c4f3fe29760c9e88dfda48f5ad2291aea58ac4f2e4787cdaf82", environment: "production" };
const useDev = new URLSearchParams(location.search).get("ckenv") === "dev";

export const CONFIG = {
  containerIdentifier: "iCloud.com.fbmore.TicTacCube",
  ...(useDev ? DEV : PROD),
};
