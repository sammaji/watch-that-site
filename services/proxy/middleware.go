package main

import (
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/valyala/fasthttp"
)

const apiKeyHeader = "x-api-key"

// loggingMiddleware logs method, path, status, and latency for every request.
func loggingMiddleware(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		start := time.Now()
		next(ctx)
		slog.Info("req", "method", string(ctx.Method()), "path", string(ctx.Path()),
			"status", strconv.Itoa(ctx.Response.StatusCode()), "latency", time.Since(start))
	}
}

// recoveryMiddleware catches panics and returns 500 instead of crashing.
func recoveryMiddleware(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic recovered")
				writeJSON(ctx, fasthttp.StatusInternalServerError, map[string]string{"error": "internal server error"})
			}
		}()
		next(ctx)
	}
}

// authMiddleware rejects requests unless they present the configured API key.
// Auth is skipped entirely when DISABLE_AUTH is truthy.
func authMiddleware(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	if os.Getenv("DISABLE_AUTH") == "true" {
		slog.Warn("proxy authentication disabled")
		return next
	}

	expected := os.Getenv("PROXY_API_KEY")
	return func(ctx *fasthttp.RequestCtx) {
		if expected == "" {
			slog.Error("proxy api key is not configured")
			writeJSON(ctx, fasthttp.StatusServiceUnavailable, map[string]string{"error": "proxy authentication is not configured"})
			return
		}

		if string(ctx.Request.Header.Peek(apiKeyHeader)) != expected {
			ctx.Response.Header.Set("WWW-Authenticate", "ApiKey")
			writeJSON(ctx, fasthttp.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		next(ctx)
	}
}
