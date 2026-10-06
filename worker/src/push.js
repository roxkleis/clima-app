const enc=new TextEncoder();
function b64d(s){if(!s)return new Uint8Array();const p="=".repeat((4-s.length%4)%4);const r=atob((s+p).replace(/-/g,"+").replace(/_/g,"/"));const o=new Uint8Array(r.length);for(let i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function b64e(a){let b="";for(let i=0;i<a.length;i+=0x8000)b+=String.fromCharCode(...a.subarray(i,i+0x8000));return btoa(b).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
const cat=(...ps)=>{const o=new Uint8Array(ps.reduce((n,p)=>n+p.length,0));let i=0;for(const p of ps){o.set(p,i);i+=p.length}return o};
async function vapidJwt(aud,subject,pub,priv){
  const P=b64d(pub),D=b64d(priv);
  if(P.length!==65||P[0]!==4) throw new Error("VAPID public key inválida");
  if(D.length!==32) throw new Error("VAPID private key inválida");
  const jwk={kty:"EC",crv:"P-256",x:b64e(P.slice(1,33)),y:b64e(P.slice(33)),d:b64e(D)};
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"ECDSA",namedCurve:"P-256"},false,["sign"]);
  const h=b64e(enc.encode(JSON.stringify({typ:"JWT",alg:"ES256"})));
  const p=b64e(enc.encode(JSON.stringify({aud,exp:Math.floor(Date.now()/1000)+43200,sub:subject})));
  const input=h+"."+p;const sig=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,enc.encode(input));
  if(new Uint8Array(sig).length!==64) throw new Error("VAPID ECDSA signature inválida");
  return input+"."+b64e(new Uint8Array(sig));
}
async function encryptPayload(payload,p256dh,auth){
  const client=b64d(p256dh),authBytes=b64d(auth);
  if(client.length!==65||client[0]!==4) throw new Error("Push p256dh inválido");
  if(authBytes.length!==16) throw new Error("Push auth inválido");
  const kp=await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"},true,["deriveBits"]);
  const clientKey=await crypto.subtle.importKey("raw",client,{name:"ECDH",namedCurve:"P-256"},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH",public:clientKey},kp.privateKey,256));
  const serverPub=new Uint8Array(await crypto.subtle.exportKey("raw",kp.publicKey));
  const info=cat(enc.encode("WebPush: info"),new Uint8Array([0]),client,serverPub);
  const sharedKey=await crypto.subtle.importKey("raw",shared,"HKDF",false,["deriveBits","deriveKey"]);
  const ikm=new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:authBytes,info},sharedKey,256));
  const ikmKey=await crypto.subtle.importKey("raw",ikm,"HKDF",false,["deriveBits","deriveKey"]);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info:cat(enc.encode("Content-Encoding: aes128gcm"),new Uint8Array([0]))},ikmKey,{name:"AES-GCM",length:128},false,["encrypt"]);
  const nonce=new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt,info:cat(enc.encode("Content-Encoding: nonce"),new Uint8Array([0]))},ikmKey,96));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce},cek,cat(payload,new Uint8Array([2]))));
  const header=new Uint8Array(86);header.set(salt);new DataView(header.buffer).setUint32(16,4096,false);header[20]=65;header.set(serverPub,21);
  return cat(header,cipher);
}
export async function sendPush(subscription,payload,env){
  const endpoint=new URL(subscription.endpoint);
  const jwt=await vapidJwt(endpoint.protocol+"//"+endpoint.host,env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
  const body=await encryptPayload(enc.encode(JSON.stringify(payload)),subscription.keys.p256dh,subscription.keys.auth);
  const r=await fetch(endpoint,{method:"POST",headers:{"Authorization":"vapid t="+jwt+", k="+env.VAPID_PUBLIC_KEY,"Content-Encoding":"aes128gcm","Content-Type":"application/octet-stream","TTL":"86400"},body});
  const responseText=await r.text();
  console.log("web-push",JSON.stringify({status:r.status,ok:r.ok,endpointHost:endpoint.host,body:responseText.slice(0,500)}));
  return {ok:r.ok,gone:r.status===404||r.status===410,status:r.status,body:responseText.slice(0,500)};
}