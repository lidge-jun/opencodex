/**
 * Rate Limiter Module for OpenCodex Server
 * 
 * Implements a token bucket algorithm with configurable rate limiting.
 * Distributes requests evenly across the time window.
 */

export interface RateLimitConfig {
  /** Maximum number of requests allowed per window */
  maxRequests: number;
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
  /** Whether to distribute requests evenly (true) or allow bursts (false) */
  evenDistribution: boolean;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** HTTP status code to return if not allowed */
  statusCode: number;
  /** Retry-After header value in seconds */
  retryAfter?: number;
  /** Remaining requests in current window */
  remaining: number;
  /** Time until the rate limit resets (ms) */
  resetInMs: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxTokens = maxRequests;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
    // For even distribution: refill one token every (windowMs / maxRequests) ms
    this.refillIntervalMs = windowMs / maxRequests;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefill = now - (elapsed % this.refillIntervalMs);
    }
  }

  public consume(): boolean {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    
    return false;
  }

  public getRemaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  public getTimeUntilNextToken(): number {
    this.refill();
    
    if (this.tokens >= 1) {
      return 0;
    }
    
    const timeSinceLastRefill = Date.now() - this.lastRefill;
    return Math.ceil(this.refillIntervalMs - timeSinceLastRefill);
  }
}

class SlidingWindowCounter {
  private requests: number[] = [];
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.requests = this.requests.filter(timestamp => timestamp > cutoff);
  }

  public check(): RateLimitResult {
    this.cleanup();
    
    const now = Date.now();
    const remaining = Math.max(0, this.maxRequests - this.requests.length);
    const oldestRequest = this.requests[0];
    const resetInMs = oldestRequest ? (oldestRequest + this.windowMs - now) : 0;
    
    if (this.requests.length >= this.maxRequests) {
      return {
        allowed: false,
        statusCode: 429,
        retryAfter: Math.ceil(resetInMs / 1000),
        remaining: 0,
        resetInMs,
      };
    }
    
    return {
      allowed: true,
      statusCode: 200,
      remaining,
      resetInMs,
    };
  }

  public record(): void {
    this.requests.push(Date.now());
  }
}

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets: Map<string, TokenBucket>;
  private readonly windows: Map<string, SlidingWindowCounter>;
  
  // Global rate limiter for /v1/responses endpoint
  private globalBucket?: TokenBucket;
  private globalWindow?: SlidingWindowCounter;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxRequests: config.maxRequests ?? 20,
      windowMs: config.windowMs ?? 60000,
      evenDistribution: config.evenDistribution ?? true,
    };
    
    this.buckets = new Map();
    this.windows = new Map();
    
    // Initialize global limiter if configured
    if (this.config.maxRequests > 0) {
      if (this.config.evenDistribution) {
        this.globalBucket = new TokenBucket(this.config.maxRequests, this.config.windowMs);
      } else {
        this.globalWindow = new SlidingWindowCounter(this.config.maxRequests, this.config.windowMs);
      }
    }
  }

  /**
   * Check if a request should be allowed for a specific key (e.g., IP address)
   */
  public checkByKey(key: string): RateLimitResult {
    let limiter: TokenBucket | SlidingWindowCounter;
    
    if (this.config.evenDistribution) {
      if (!this.buckets.has(key)) {
        this.buckets.set(key, new TokenBucket(this.config.maxRequests, this.config.windowMs));
      }
      limiter = this.buckets.get(key)!;
      
      if (limiter instanceof TokenBucket) {
        const allowed = limiter.consume();
        return {
          allowed,
          statusCode: allowed ? 200 : 429,
          retryAfter: allowed ? undefined : Math.ceil(limiter.getTimeUntilNextToken() / 1000),
          remaining: limiter.getRemaining(),
          resetInMs: limiter.getTimeUntilNextToken(),
        };
      }
    } else {
      if (!this.windows.has(key)) {
        this.windows.set(key, new SlidingWindowCounter(this.config.maxRequests, this.config.windowMs));
      }
      limiter = this.windows.get(key)!;
      
      if (limiter instanceof SlidingWindowCounter) {
        const result = limiter.check();
        if (result.allowed) {
          limiter.record();
        }
        return result;
      }
    }
    
    return {
      allowed: true,
      statusCode: 200,
      remaining: this.config.maxRequests,
      resetInMs: this.config.windowMs,
    };
  }

  /**
   * Check if a global request should be allowed (for /v1/responses endpoint)
   */
  public checkGlobal(): RateLimitResult {
    if (!this.config.evenDistribution && this.globalWindow) {
      const result = this.globalWindow.check();
      if (result.allowed) {
        this.globalWindow.record();
      }
      return result;
    }
    
    if (this.globalBucket) {
      const allowed = this.globalBucket.consume();
      return {
        allowed,
        statusCode: allowed ? 200 : 429,
        retryAfter: allowed ? undefined : Math.ceil(this.globalBucket.getTimeUntilNextToken() / 1000),
        remaining: this.globalBucket.getRemaining(),
        resetInMs: this.globalBucket.getTimeUntilNextToken(),
      };
    }
    
    return {
      allowed: true,
      statusCode: 200,
      remaining: this.config.maxRequests,
      resetInMs: this.config.windowMs,
    };
  }

  /**
   * Extract client identifier from request (IP address or other identifier)
   */
  public getClientKey(req: Request): string {
    // Try to get real IP from headers (behind proxy/load balancer)
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      return forwarded.split(",")[0].trim();
    }
    
    const realIp = req.headers.get("x-real-ip");
    if (realIp) {
      return realIp;
    }
    
    // Fall back to URL host or a default identifier
    try {
      const url = new URL(req.url);
      return url.hostname || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Get current configuration
   */
  public getConfig(): RateLimitConfig {
    return { ...this.config };
  }

  /**
   * Update configuration dynamically
   */
  public updateConfig(newConfig: Partial<RateLimitConfig>): void {
    if (newConfig.maxRequests !== undefined) {
      this.config.maxRequests = newConfig.maxRequests;
    }
    if (newConfig.windowMs !== undefined) {
      this.config.windowMs = newConfig.windowMs;
    }
    if (newConfig.evenDistribution !== undefined) {
      this.config.evenDistribution = newConfig.evenDistribution;
      
      // Reinitialize limiters when switching modes
      this.buckets.clear();
      this.windows.clear();
      
      if (this.config.evenDistribution) {
        this.globalBucket = new TokenBucket(this.config.maxRequests, this.config.windowMs);
        this.globalWindow = undefined;
      } else {
        this.globalWindow = new SlidingWindowCounter(this.config.maxRequests, this.config.windowMs);
        this.globalBucket = undefined;
      }
    }
  }

  /**
   * Reset rate limit for a specific key
   */
  public resetByKey(key: string): void {
    this.buckets.delete(key);
    this.windows.delete(key);
  }

  /**
   * Reset all rate limits
   */
  public resetAll(): void {
    this.buckets.clear();
    this.windows.clear();
    
    if (this.config.evenDistribution) {
      this.globalBucket = new TokenBucket(this.config.maxRequests, this.config.windowMs);
    } else {
      this.globalWindow = new SlidingWindowCounter(this.config.maxRequests, this.config.windowMs);
    }
  }
}

// Singleton instance for global rate limiting
let globalRateLimiter: RateLimiter | undefined;

export function getGlobalRateLimiter(): RateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new RateLimiter({
      maxRequests: 20,
      windowMs: 60000,
      evenDistribution: true,
    });
  }
  return globalRateLimiter;
}

export function setGlobalRateLimiter(limiter: RateLimiter): void {
  globalRateLimiter = limiter;
}

/**
 * Create rate limit response headers
 */
export function createRateLimitHeaders(result: RateLimitResult): Headers {
  const headers = new Headers();
  headers.set("X-RateLimit-Limit", String(result.remaining + (result.allowed ? 0 : 1)));
  headers.set("X-RateLimit-Remaining", String(result.remaining));
  
  if (result.retryAfter) {
    headers.set("Retry-After", String(result.retryAfter));
  }
  
  return headers;
}

/**
 * Create a rate limited response
 */
export function createRateLimitedResponse(result: RateLimitResult, message?: string): Response {
  const headers = createRateLimitHeaders(result);
  
  if (!result.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: message || "Too many requests. Please slow down.",
        },
      }),
      {
        status: result.statusCode,
        headers: {
          ...Object.fromEntries(headers),
          "Content-Type": "application/json",
        },
      }
    );
  }
  
  return new Response(null, { status: 200, headers });
}
