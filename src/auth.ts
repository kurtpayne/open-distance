export function checkKey(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function deniedResponse(): Response {
  const body = {
    status: "REQUEST_DENIED",
    error_message: "The provided API key is invalid.",
    rows: [],
    origin_addresses: [],
    destination_addresses: [],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}
