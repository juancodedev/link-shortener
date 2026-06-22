// Entry point placeholder — will be implemented in Phase 6
export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response("Link Shortener", { status: 200 });
  },
};
