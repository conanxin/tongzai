declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LIVEKIT_URL?: string;
    LIVEKIT_API_KEY?: string;
    LIVEKIT_API_SECRET?: string;
    TURN_URL?: string;
    TURN_USERNAME?: string;
    TURN_CREDENTIAL?: string;
    STUN_URLS?: string;
    TURN_SHARED_SECRET?: string;
    TURN_TTL_SECONDS?: string;
    ICE_TRANSPORT_POLICY?: string;
  }
}
