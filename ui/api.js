/** JSON management requests shared by the browser page and desktop settings. */
export function createManagerApi(root, signal, transport = fetch) {
  return async (action, body) => {
    const response = await transport(new URL(`api/${action}`, root), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-dsh-speech-adapter': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal,
    })
    const result = await response.json()
    signal.throwIfAborted()
    if (!response.ok) throw new Error(result.error ?? 'external-upstream-failed')
    return result
  }
}
