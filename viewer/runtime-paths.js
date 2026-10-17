import wasmUrl from "./flood.wasm?url";
// Shared by the page and module worker; Vite resolves it relative to each chunk.
self.FloodWasmURL = wasmUrl;
