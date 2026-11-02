import type { ResultOf } from "@brooswit/herdr-sdk";
import type { Correction, CorrectionContext } from "./corrections.js";
export declare const correctCodexTrustList: Correction<"agent.list">;
export declare function correctCodexTrustAgent<M extends "agent.get" | "agent.start" | "agent.prompt" | "agent.wait">(result: ResultOf<M>, ctx: CorrectionContext<M>): Promise<ResultOf<M>>;
