interface Env {
  ASSETS: Fetcher;
  API_ORIGIN: string;
}

const LEGACY_PREFIX = "app.";
const FONTS_PREFIX = "/fonts/";

const withFontCors = async (pending: Promise<Response>): Promise<Response> => {
  const response = await pending;
  const answer = new Response(response.body, response);
  answer.headers.set("access-control-allow-origin", "*");
  return answer;
};

const apiOrigin = (configured: string | undefined): string => {
  if (!configured)
    throw new Error("API_ORIGIN is not set; deploy the dashboard with --var API_ORIGIN:https://<api host>");
  const origin = new URL(configured).origin;
  if (origin !== configured)
    throw new Error(`API_ORIGIN ${configured} must be a bare origin such as https://api.example.com`);
  return origin;
};

const withApiOrigin = async (pending: Promise<Response>, origin: string): Promise<Response> => {
  const response = await pending;
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  return new HTMLRewriter()
    .on("head", {
      element: (head) => {
        head.prepend(`<meta name="tumpel-api-origin" content="${origin}">`, { html: true });
      },
    })
    .transform(response);
};

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.hostname.startsWith(LEGACY_PREFIX)) {
      url.hostname = url.hostname.slice(LEGACY_PREFIX.length);
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname.startsWith(FONTS_PREFIX)) return withFontCors(env.ASSETS.fetch(request));
    return withApiOrigin(env.ASSETS.fetch(request), apiOrigin(env.API_ORIGIN));
  },
};
