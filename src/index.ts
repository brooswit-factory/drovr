export const DROVR_PACKAGE_NAME = "@brooswit/drovr";

export { DrovrClient, type DrovrClientOptions } from "./drovr-client.js";
export {
  type CallIdentity,
  type ChokePoint,
  type Invoke,
  passThroughChokePoint,
} from "./choke-point.js";

// Re-exported so a migrated consumer never has to import from both
// drovr and @brooswit/herdr-sdk for the pieces DrovrClient hands back
// unchanged: error types (HerdrError, isTimeout), the subscription handle,
// and the SDK's own generated/typed-escape-hatch types.
export * from "@brooswit/herdr-sdk";
