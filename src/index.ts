import { checkKey, deniedResponse } from "./auth";
import { Env as V2Env, handleDistanceMatrix as v2Handle, healthCheck as v2Health } from "./v2/distancematrix";

type Env = V2Env;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") {
      return v2Health(env);
    }

    if (url.pathname === "/maps/api/distancematrix/json") {
      const key = url.searchParams.get("key");
      if (!checkKey(key, env.API_KEY)) return deniedResponse();
      return v2Handle(url, env);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
