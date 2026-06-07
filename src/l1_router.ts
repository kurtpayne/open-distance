// L1Router DurableObject: holds the L1 highway overlay in memory persistently
// and serves cross-country routing requests from the Worker. Workers isolate
// has a documented 128 MB cap; DOs (empirically) have ~140 MB which lets the
// ~131 MB L1 binary stay resident. Putting L1 in its own DO also avoids the
// warm-isolate problem: in a shared Worker isolate the L1 binary would stay
// cached and OOM L0 queries on the same isolate.

import { decodeL1, bidirAStarL1, snapL1, L1Graph } from "./l1_graph";

interface L1RouteRequest {
  srcLat: number;
  srcLon: number;
  dstLat: number;
  dstLon: number;
  settledCap?: number;
}
interface L1RouteResponse {
  ok: boolean;
  timeS?: number;
  lenM?: number;
  settled?: number;
  srcSnapDistM?: number;
  dstSnapDistM?: number;
  reason?: string;
  // Debug instrumentation
  loadMs?: number;
  routeMs?: number;
  memoryBytes?: number;
}

interface L1Env {
  GRAPH: R2Bucket;
  DATA_VERSION: string;
}

export class L1Router {
  private state: DurableObjectState;
  private env: L1Env;
  private graph: L1Graph | null = null;
  private loadPromise: Promise<L1Graph> | null = null;

  constructor(state: DurableObjectState, env: L1Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Lazy-load the L1 binary from R2. The graph is bidirectional by construction
   * so no reverse CSR is needed -- bidir A* reuses the forward CSR for backward
   * expansion. All concurrent requests share the same loadPromise to avoid
   * double-fetch.
   */
  private async getGraph(): Promise<L1Graph> {
    if (this.graph) return this.graph;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const key = `overlay/${this.env.DATA_VERSION}/l1.bin`;
      const obj = await this.env.GRAPH.get(key);
      if (!obj) throw new Error(`L1 overlay missing: ${key}`);
      const buf = await obj.arrayBuffer();
      const decoded = decodeL1(buf);
      this.graph = decoded;
      this.loadPromise = null;
      return decoded;
    })();
    return this.loadPromise;
  }

  /**
   * Diagnostic: report whether L1 is loaded + rough memory footprint. Used
   * by the Worker's /healthz/l1 endpoint to verify the DO's state without
   * triggering a full route.
   */
  async status(): Promise<{ loaded: boolean; nNodes?: number; mEdges?: number }> {
    if (!this.graph) return { loaded: false };
    return { loaded: true, nNodes: this.graph.n, mEdges: this.graph.m };
  }

  /**
   * Main RPC: route from (srcLat, srcLon) to (dstLat, dstLon) using bidir A*
   * over the L1 highway overlay. Returns NaN time/len if no path found.
   */
  async route(req: L1RouteRequest): Promise<L1RouteResponse> {
    const tLoad0 = Date.now();
    let graph: L1Graph;
    try {
      graph = await this.getGraph();
    } catch (e) {
      return { ok: false, reason: `L1 load failed: ${(e as Error).message}` };
    }
    const loadMs = Date.now() - tLoad0;

    const src = snapL1(graph, req.srcLat, req.srcLon, /*requireOutgoing=*/true);
    const dst = snapL1(graph, req.dstLat, req.dstLon, /*requireOutgoing=*/false);
    if (!src) return { ok: false, reason: "src snap failed", loadMs };
    if (!dst) return { ok: false, reason: "dst snap failed", loadMs };

    const tRoute0 = Date.now();
    const result = bidirAStarL1(graph, src.node, dst.node, req.settledCap ?? 1_500_000);
    const routeMs = Date.now() - tRoute0;

    if (!result) {
      return {
        ok: false,
        reason: "no path",
        srcSnapDistM: src.distM, dstSnapDistM: dst.distM,
        loadMs, routeMs,
      };
    }
    return {
      ok: true,
      timeS: result.timeS,
      lenM: result.lenM,
      settled: result.settled,
      srcSnapDistM: src.distM,
      dstSnapDistM: dst.distM,
      loadMs, routeMs,
    };
  }

  /**
   * Standard fetch handler routes JSON-RPC-ish requests by URL path.
   * Workers calls the DO via `stub.fetch(request)`; this dispatches.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json(await this.status());
    }
    if (url.pathname === "/route") {
      const body = (await req.json()) as L1RouteRequest;
      const out = await this.route(body);
      return Response.json(out);
    }
    return new Response("Not Found", { status: 404 });
  }
}
