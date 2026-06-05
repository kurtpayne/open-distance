import { checkKey, deniedResponse } from "./auth";
import { Env, handleDistanceMatrix } from "./distancematrix";
import { getGraph } from "./graph";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      try {
        const g = await getGraph(env.GRAPH, env.DATA_VERSION);
        return new Response(JSON.stringify({
          status: "ok",
          version: env.DATA_VERSION,
          nodes: g.N,
          edges: g.M,
        }), { headers: { "content-type": "application/json; charset=UTF-8" } });
      } catch (e) {
        return new Response(JSON.stringify({
          status: "warming",
          version: env.DATA_VERSION,
          error: (e as Error).message,
        }), { status: 503, headers: { "content-type": "application/json; charset=UTF-8" } });
      }
    }

    if (url.pathname === "/maps/api/distancematrix/json") {
      const key = url.searchParams.get("key");
      if (!checkKey(key, env.API_KEY)) return deniedResponse();
      return handleDistanceMatrix(url, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
