// Generates a fresh RSA-OAEP-2048 keypair for the shared-API-key feature
// (see js/ai/sharedKeyVault.js and proxy/cloudflare-giphy-worker.js).
//
// Run with: node scripts/generate-shared-key-pair.mjs
//
// The PUBLIC key it prints goes into SHARING_PUBLIC_KEY_JWK in
// js/ai/sharedKeyVault.js — it's safe to commit, it can only encrypt.
// The PRIVATE key goes into the Cloudflare Worker secret
// SHARED_KEY_VAULT_PRIVATE_KEY (`wrangler secret put SHARED_KEY_VAULT_PRIVATE_KEY`)
// — never commit it, never put it in any file the browser can load.

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"]
);

const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);

console.log("PUBLIC key — paste as SHARING_PUBLIC_KEY_JWK in js/ai/sharedKeyVault.js:\n");
console.log(JSON.stringify(publicJwk, null, 2));

console.log("\n\nPRIVATE key — store ONLY as the Cloudflare secret SHARED_KEY_VAULT_PRIVATE_KEY, never commit this:\n");
console.log(JSON.stringify(privateJwk));
