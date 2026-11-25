export default {
  fetch: (request: Request): Response => {
    const url = new URL(request.url);
    if (!url.hostname.startsWith("app.")) return new Response(null, { status: 204 });
    return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 308);
  },
};
