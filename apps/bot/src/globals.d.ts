/// <reference types="@cloudflare/workers-types" />

declare module '*.wasm' {
  const asset: string
  export default asset
}

declare module '*.woff2' {
  const asset: string
  export default asset
}
