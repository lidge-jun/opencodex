/** Hold a send's accounting lease until its response body terminates. */
export function holdMuseResponse(response: Response, release: () => void, signal?: AbortSignal): Response {
  let released = false;
  const finish = () => { if (!released) { released = true; release(); } };
  if (!response.body) { finish(); return response; }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch (error) { finish(); throw error; }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { finish(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) {
        finish();
        if (signal?.aborted) { try { controller.close(); } catch { /* consumer already closed */ } }
        else controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      catch (error) { if (!signal?.aborted) throw error; }
      finally { finish(); }
    },
  });
  try { return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }); }
  catch (error) { finish(); void reader.cancel().catch(() => {}); throw error; }
}
