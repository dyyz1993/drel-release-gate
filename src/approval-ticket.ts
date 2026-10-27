export class ApprovalTicket {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/claim') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const claimed = await this.state.storage.transaction(async txn => {
        if (await txn.get('claimed')) return false;
        await txn.put('claimed', true);
        return true;
      });
      return Response.json({ claimed }, { status: claimed ? 200 : 409 });
    }
    if (url.pathname === '/release') {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      await this.state.storage.delete('claimed');
      return Response.json({ released: true });
    }
    return new Response(null, { status: 404 });
  }
}
